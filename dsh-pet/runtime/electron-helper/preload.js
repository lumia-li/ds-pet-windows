// preload 桥：只暴露窗口控制原语——
//   - setBounds：宠物窗口逐帧跟随（renderer 上报包围盒的屏幕坐标，主进程 setContentBounds）。
//     x/y/width/height = 窗口内容区坐标（用于移动窗口）；boxX/boxY = 宠物包围盒左上角
//     （工作区坐标）——碰撞站场必须用包围盒坐标，不能用窗口坐标（窗口 = 包围盒 + 四周外扩 margin，
//     差半只宠物宽，会让跨窗碰撞检测整体错位）。
//     size/bottomPad = 碰撞站场登记用（静止宠物只发 set-bounds，靠它带上尺寸才能被其它
//     飞行宠物撞到）；vx/vy = 当前速度（飞行中实时值，静止/拖拽 = 0）。
//     marginL/marginT = 窗口左右/上余量（DIP）——主进程算宠物身体命中区要用。**不能再省**：
//     上边距按气泡最大高度加高后余量不再四边相等，主进程按「窗口宽/4」反推会让命中区整体偏上。
//   - setInteractive：点击穿透翻转——窗口默认整窗穿透（透明像素不挡下层应用），
//     renderer 在光标进/出宠物身体命中区时上报，主进程 setIgnoreMouseEvents 翻转。
//   - setInputBusy：**我正在用这个窗口的鼠标输入**（拖拽中 / 菜单开着 / 对话弹窗开着），
//     由渲染端上报。主进程光看光标位置与窗口位移分不清"拖拽跟手"和"漫游/抛掷"，而渲染端知道。
//     busy 期间主进程的兜底通道**绝不翻回穿透**（一旦翻回，渲染端正在用的 window 级
//     pointermove/pointerup 就断了：宠物会按旧速度飞出去，连松手的 pointerup 都收不到）。
//     只在状态翻转时发一次（幂等，不逐帧）。
//   - 宠物间碰撞（跨窗，主进程 broker）：
//       reportFlight：飞行中每 ~30ms 上报自己的状态（位置/速度/尺寸）→ 主进程汇聚并广播；
//       onFlightStates：订阅主进程广播的全量宠物状态（碰撞检测用其它宠物的最新位置/速度）；
//       reportCollide：本窗飞行方检测到撞到 targetId → 主进程把动量结果转发给目标窗；
//       onPetHit：订阅「你被撞了」→ 用新初速 startThrow 抛出去（与浏览器 onHit 同语义）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  setBounds(x, y, width, height, boxX, boxY, size, bottomPad, vx, vy, marginL, marginT) {
    ipcRenderer.send('pet:set-bounds', {
      x,
      y,
      width,
      height,
      boxX,
      boxY,
      size,
      bottomPad,
      vx,
      vy,
      marginL,
      marginT,
    });
  },
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  // 忙碌态配合 setInputRegions：拖拽持续捕获，菜单/聊天框外仍可点击其它应用。
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  setInputRegions(input) {
    ipcRenderer.send('pet:input-regions', input);
  },
  // 右键菜单「打开网站」：主进程按宿主形态打开——桌面应用宿主唤起桌面窗口（dsh://open），否则系统默认浏览器打开 DSH 网站（等效网页 Ctrl+点击链接）
  openDshSite(url) {
    ipcRenderer.send('pet:open-site', { url });
  },
  // 独立应用的「设置」菜单项：打开本进程的设置窗口（单实例，重复点击只叫到前台）
  openSettings() {
    ipcRenderer.send('pet:open-settings');
  },
  // 在资源管理器里定位一个文件（设置窗口右上角的路径点击）。只接受绝对路径，
  // 具体放行规则在主进程（pet:reveal-path），渲染端拿不到任意 shell 执行能力。
  revealPath(target) {
    ipcRenderer.send('pet:reveal-path', String(target || ''));
  },
  // ---- 宠物间碰撞（跨窗 broker）----
  reportFlight(state) {
    ipcRenderer.send('pet:report-flight', state);
  },
  onFlightStates(cb) {
    ipcRenderer.on('pet:flight-states', (e, states) => cb(states));
  },
  reportCollide(targetId, vx, vy) {
    ipcRenderer.send('pet:collide-result', { targetId, vx, vy });
  },
  onPetHit(cb) {
    ipcRenderer.on('pet:hit', (e, payload) => cb(payload));
  },
  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转后主进程重算桌面几何并推来
  // （{hull, areas, primaryIndex}，屏幕坐标）——渲染端就地重挂视口与边界。
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (e, geo) => cb(geo));
  },
  // 配置热更新（设置页保存 / 右键「重载配置」）：本窗口的宠物数量没变时主进程走这条，
  // 渲染端重拉 /config、重建 sprite 即可——不关窗、不重启，改完立刻生效。
  onConfigChanged(cb) {
    ipcRenderer.on('pet:config-changed', () => cb());
  },
  // 深浅色：设置窗口切换后经主进程广播；宠物窗口据此把右键菜单等浮层换色
  setTheme(mode) {
    ipcRenderer.send('pet:theme', String(mode));
  },
  onTheme(cb) {
    ipcRenderer.on('pet:theme', (e, mode) => cb(mode));
  },
});

// 设置窗口专用：请求经 IPC 直达宿主路由（同一份 handlePetRoute），**不经本机 HTTP 服务**——
// 没有端口、没有令牌、页面就是本地文件（settings.html）。宠物窗口也用同一份 preload，
// 只是不会去碰这个对象。
contextBridge.exposeInMainWorld('petSettings', {
  /**
   * 发一次宿主请求。
   * @param {string} method GET / PUT / POST / DELETE
   * @param {string} path 完整路由路径（`/dsh-pet-7340/config`、`/standalone-ai/settings` …）
   * @param {string} [body] 请求体（JSON 文本）
   * @returns {Promise<{status:number, body:string}>} 宿主应答（body 为文本，页面自行解析）
   */
  request(method, path, body) {
    return ipcRenderer.invoke('pet:host-request', { method, path, body });
  },
});

// 设置窗口是 frame:false 的无边框窗口：标题栏由页面自绘，最小化/关闭走这两个原语。
contextBridge.exposeInMainWorld('petWindow', {
  minimize() {
    ipcRenderer.send('pet:settings-window', 'minimize');
  },
  close() {
    ipcRenderer.send('pet:settings-window', 'close');
  },
  /**
   * 页面数据就绪（配置拉完并渲染完）：主进程据此才把窗口显示出来。
   * 早于它的显示都会露出"空卡片 + 空下拉"的骨架（用户看到的那一下闪烁）。
   */
  ready() {
    ipcRenderer.send('pet:settings-ready');
  },
});
