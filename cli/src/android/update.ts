import { Config } from '../config';
import { log, runTask } from '../common';
import { getFilePath, getPlatformElement, getPluginPlatform, getPlugins, getPluginType, Plugin, PluginType } from '../plugin';
import { getAndroidPlugins } from './common';
import { handleCordovaPluginsJS } from '../cordova';
import { copySync, ensureDirSync, readFileAsync, removeSync, writeFileAsync } from '../util/fs';
import { allSerial } from '../util/promise';
import { join, resolve } from 'path';

const platform = 'android';

export async function updateAndroid(config: Config, needsUpdate: boolean) {
  const plugins = await runTask('Fetching plugins', async () => {
    const allPlugins = await getPlugins(config);
    const androidPlugins = await getAndroidPlugins(config, allPlugins);
    return androidPlugins;
  });

  const capacitorPlugins = plugins.filter(p => getPluginType(p, platform) === PluginType.Code);
  const cordovaPlugins = plugins.filter(p => getPluginType(p, platform) === PluginType.Cordova);

  if (cordovaPlugins.length > 0) {
    copyPluginsNativeFiles(config, cordovaPlugins);
  } else {    
    removePluginsNativeFiles(config);
  }
  await handleCordovaPluginsJS(cordovaPlugins, config, platform);
  await installGradlePlugins(config, capacitorPlugins);
  await handleCordovaPluginsGradle(config, cordovaPlugins);
}

export async function installGradlePlugins(config: Config, plugins: Plugin[]) {
  log(`Found ${plugins.length} Capacitor plugin(s):\n${plugins.map(p => '  ' + p.name).join('\n')}`);

  const settingsLines = `// DO NOT EDIT THIS FILE! IT IS GENERATED EACH TIME "capacitor update" IS RUN
${plugins.map(p => {
    return `
include ':${p.id}'
project(':${p.id}').projectDir = new File('../node_modules/${p.id}/android/${p.id}')
    `;
  }).join('')}`;


const dependencyLines = `// DO NOT EDIT THIS FILE! IT IS GENERATED EACH TIME "capacitor update" IS RUN

dependencies {
${plugins.map(p => {
    return `    implementation project(':${p.id}')`;
  }).join('\n')}
}`;

  await writeFileAsync(join(config.app.rootDir, 'android/capacitor.settings.gradle'), settingsLines);
  await writeFileAsync(join(config.app.rootDir, 'android/app/capacitor.build.gradle'), dependencyLines)
}

export async function handleCordovaPluginsGradle(config: Config,  cordovaPlugins: Plugin[]) {
  const pluginsFolder = resolve(config.app.rootDir, 'node_modules', '@capacitor/cli', 'assets', 'capacitor-android-plugins');
  const pluginsGradlePath = join(pluginsFolder, 'build.gradle');
  let frameworksArray: Array<any> = [];
  let preferencessArray: Array<any> = [];
  let applyArray: Array<any> = [];
  cordovaPlugins.map( p => {
    const frameworks = getPlatformElement(p, platform, 'framework');
    frameworks.map((framework: any) => {
      if (!framework.$.type && !framework.$.custom) {
        frameworksArray.push(framework.$.src);
      } else if (framework.$.custom && framework.$.custom === "true" && framework.$.type && framework.$.type === "gradleReference"){
        const fileName = framework.$.src.split("/").pop();
        applyArray.push(join(p.id, fileName));
      }
    });
    preferencessArray = preferencessArray.concat(getPlatformElement(p, platform, 'preference'));
  });
  let frameworkString = frameworksArray.map(f => {
    return `    implementation "${f}"`;
  }).join('\n');
  let applyString = applyArray.map(ap => {
    return `apply from: "${pluginsFolder}/gradle-files/${ap}"`
  }).join('\n');
  preferencessArray.map((preference: any) => {
    frameworkString = frameworkString.replace(new RegExp(("$"+preference.$.name).replace('$', '\\$&'), 'g'), preference.$.default);
  });
  let buildGradle = await readFileAsync(pluginsGradlePath, 'utf8');
  buildGradle = buildGradle.replace(/(SUB-PROJECT DEPENDENCIES START)[\s\S]*(\/\/ SUB-PROJECT DEPENDENCIES END)/, '$1\n' + frameworkString.concat("\n") + '    $2');
  buildGradle = buildGradle.replace(/(PLUGIN GRADLE EXTENSIONS START)[\s\S]*(\/\/ PLUGIN GRADLE EXTENSIONS END)/, '$1\n' + applyString.concat("\n") + '$2');
  await writeFileAsync(pluginsGradlePath, buildGradle);
}

function copyPluginsNativeFiles(config: Config, cordovaPlugins: Plugin[]) {
  const pluginsRoot = resolve(config.app.rootDir, 'node_modules', '@capacitor/cli', 'assets', 'capacitor-android-plugins');
  const pluginsPath = join(pluginsRoot, 'src', 'main');
  removePluginsNativeFiles(config);
  cordovaPlugins.map( p => {
    const androidPlatform = getPluginPlatform(p, platform);
    if (androidPlatform) {
      const sourceFiles = androidPlatform['source-file'];
      if (sourceFiles) {
        sourceFiles.map( (sourceFile: any) => {
          const fileName = sourceFile.$.src.split("/").pop();
          const target = sourceFile.$["target-dir"].replace('src/', 'java/');
          copySync(getFilePath(config, p, sourceFile.$.src), join(pluginsPath, target, fileName));
        });
      }
      const resourceFiles = androidPlatform['resource-file'];
      if(resourceFiles) {
        resourceFiles.map( (resourceFile: any) => {
          if (resourceFile.$.src.split(".").pop() === "aar") {
            copySync(getFilePath(config, p, resourceFile.$.src), join(pluginsPath, 'libs', resourceFile.$["target"].split("/").pop()));
          } else {
            copySync(getFilePath(config, p, resourceFile.$.src), join(pluginsPath, resourceFile.$["target"]));
          }
        });
      }
      const frameworks = getPlatformElement(p, platform, 'framework');
      frameworks.map((framework: any) => {
        if (framework.$.custom && framework.$.custom === "true" && framework.$.type && framework.$.type === "gradleReference"){
          const fileName = framework.$.src.split("/").pop();
          copySync(getFilePath(config, p, framework.$.src), join(pluginsRoot, 'gradle-files', p.id, fileName));
        }
      });
      const libFiles = getPlatformElement(p, platform, 'lib-file');
      libFiles.map((libFile: any) => {
        copySync(getFilePath(config, p, libFile.$.src), join(pluginsPath, 'libs', libFile.$.src.split("/").pop()));
      });
    }
  });
}

function removePluginsNativeFiles(config: Config) {
  const pluginsRoot = resolve(config.app.rootDir, 'node_modules', '@capacitor/cli', 'assets', 'capacitor-android-plugins');
  const pluginsPath = join(pluginsRoot, 'src', 'main');
  removeSync(join(pluginsRoot, 'gradle-files'));
  removeSync(join(pluginsPath, 'java'));
  removeSync(join(pluginsPath, 'res'));
  removeSync(join(pluginsPath, 'libs'));
}
