import {readFile} from 'node:fs/promises';
const moduleUrl = (source:string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const asset = (name:string) => readFile(new URL(`../../../packages/web/plugins/execution/src/assets/${name}`,import.meta.url),'utf8');
export async function loadExecutionBrowserAssets() {
  const [source,navigation,guidance,workbench,capacity,cancellation,uiSource,tokens,common,execution] = await Promise.all([
    asset('panel.js'),asset('navigation.js'),asset('guidance.js'),asset('workbench.js'),asset('capacity.js'),asset('cancellation.js'),
    readFile(new URL('../../../packages/web/core/src/assets/feature-ui.js',import.meta.url),'utf8'),
    readFile(new URL('../../../packages/web/core/src/assets/tokens.css',import.meta.url),'utf8'),
    readFile(new URL('../../../packages/web/core/src/assets/app.css',import.meta.url),'utf8'),asset('execution.css')
  ]);
  const panelSource = source.replace('"./navigation.js"',JSON.stringify(moduleUrl(navigation))).replaceAll('"./guidance.js"',JSON.stringify(moduleUrl(guidance)))
    .replace('"./workbench.js"',JSON.stringify(moduleUrl(workbench.replace('"./execution.css"',JSON.stringify('data:text/css,')))))
    .replace("'./capacity.js'",JSON.stringify(moduleUrl(capacity))).replace("'./cancellation.js'",JSON.stringify(moduleUrl(cancellation)));
  return {panelSource,uiSource,styles:[tokens,common,execution].join('\n')};
}
