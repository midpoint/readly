import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import "./styles/main.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);

window.addEventListener("readly:unauthorized", () => {
  void router.push("/login");
});

app.mount("#app");
