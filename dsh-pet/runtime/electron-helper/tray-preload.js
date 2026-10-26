'use strict';

/**
 * 自绘托盘菜单的桥（只暴露三个原语）。
 *
 * 为什么托盘菜单要自绘：`tray.setContextMenu` 用的是**Windows 原生菜单**，配色由系统
 * 「应用模式」决定，应用里切到浅色主题它可能仍是深色（用户反馈的"托盘还是黑的"）。
 * 自绘就是一个小透明窗口 + 一块 HTML，颜色跟着应用主题走。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayMenu', {
  /** 菜单数据（宠物清单 + 是否可退出）：主进程在页面加载完时推送 */
  onData(cb) {
    ipcRenderer.on('tray-menu:data', (event, payload) => cb(payload));
  },
  /** 内容尺寸：主进程据此把窗口收到正好大小再定位显示 */
  size(dimensions) {
    ipcRenderer.send('tray-menu:size', dimensions);
  },
  /** 选中某一项（宠物切换 / 退出） */
  select(payload) {
    ipcRenderer.send('tray-menu:select', payload);
  },
  /** 请求关闭（Esc / 失焦） */
  close() {
    ipcRenderer.send('tray-menu:close');
  },
  /** 主题变化（设置窗口切换深浅色时主进程广播）：隐藏中的菜单窗口也能立刻换上 */
  onTheme(cb) {
    ipcRenderer.on('tray-menu:theme', (event, mode) => cb(mode === 'dark' ? 'dark' : 'light'));
  },
});
