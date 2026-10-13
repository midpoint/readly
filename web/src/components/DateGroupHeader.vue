<script setup lang="ts">
defineProps<{ label: string }>();
</script>

<template>
  <div class="sticky top-9 z-10 bg-neutral-50/90 px-4 py-1.5 text-xs font-medium text-neutral-500 backdrop-blur dark:bg-neutral-950/90">
    {{ label }}
  </div>
</template>
