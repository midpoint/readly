import { createRouter, createWebHistory } from "vue-router";
import { getToken } from "@/api/client";
import Login from "@/views/Login.vue";
import Inbox from "@/views/Inbox.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: Login },
    { path: "/", name: "inbox", component: Inbox },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach((to) => {
  if (to.name !== "login" && !getToken()) return { name: "login" };
  if (to.name === "login" && getToken()) return { name: "inbox" };
  return true;
});
