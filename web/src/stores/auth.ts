import { defineStore } from "pinia";
import { ref } from "vue";
import { api, clearToken, getToken, setToken } from "@/api/client";

export const useAuthStore = defineStore("auth", () => {
  const valid = ref<boolean | null>(null);

  async function check(): Promise<boolean> {
    if (!getToken()) {
      valid.value = false;
      return false;
    }
    try {
      await api<{ ok: boolean }>("/api/auth/check");
      valid.value = true;
    } catch {
      valid.value = false;
    }
    return valid.value;
  }

  async function login(token: string): Promise<boolean> {
    setToken(token);
    const okRes = await check();
    if (!okRes) clearToken();
    return okRes;
  }

  function logout(): void {
    clearToken();
    valid.value = false;
  }

  return { valid, check, login, logout };
});
