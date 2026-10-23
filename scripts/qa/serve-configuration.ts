/** Disposable empty installation for configuration UI acceptance. */
import { buildApp } from '../../server/index.js';
const app=await buildApp({databasePath:':memory:',staticRoot:'dist/web'});
const origin=await app.listen({host:'127.0.0.1',port:0});
console.log('CONFIGURATION_UI_READY '+JSON.stringify({origin}));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
