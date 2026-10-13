import { ref } from "vue";

// 模块级单例:Sidebar 的入口按钮与 Inbox 里的浮层共享同一个开关
const showShortcutHelp = ref(false);

export function useShortcutHelp() {
  return {
    showShortcutHelp,
    openShortcutHelp: () => {
      showShortcutHelp.value = true;
    },
    closeShortcutHelp: () => {
      showShortcutHelp.value = false;
    },
    toggleShortcutHelp: () => {
      showShortcutHelp.value = !showShortcutHelp.value;
    },
  };
}
