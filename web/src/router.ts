import { createRouter, createWebHistory } from "vue-router";
import { getToken } from "@/api/client";
import Login from "@/views/Login.vue";
import Inbox from "@/views/Inbox.vue";
import AddFeed from "@/views/AddFeed.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: Login },
    { path: "/", name: "inbox", component: Inbox },
    { path: "/add", name: "add", component: AddFeed },
    { path: "/events", name: "events", component: () => import("@/views/Events.vue") },
    { path: "/keywords", name: "keywords", component: () => import("@/views/Keywords.vue") },
    { path: "/keywords/:id", name: "keyword-detail", component: () => import("@/views/KeywordDetail.vue") },
    { path: "/settings", name: "settings", component: () => import("@/views/Settings.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach((to) => {
  if (to.name !== "login" && !getToken()) return { name: "login" };
  if (to.name === "login" && getToken()) return { name: "inbox" };
  return true;
});
