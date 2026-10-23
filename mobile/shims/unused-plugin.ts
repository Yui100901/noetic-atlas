export default function serverOnlyPlugin(): never { throw new Error('服务端文档插件不在离线运行时加载'); }
