import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useSettingsStore } from "./stores/settings";
import "./styles/main.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);

// 本地偏好先应用(防闪烁),服务端偏好后台合并
const settings = useSettingsStore();
settings.initLocal();
settings.initSystemWatch();
void settings.initRemote().catch(() => undefined);

window.addEventListener("readly:unauthorized", () => {
  void router.push("/login");
});

app.mount("#app");
