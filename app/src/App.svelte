<script lang="ts">
  import { onMount } from 'svelte'
  import Main from './Main.svelte'
  import { TabLock } from './tablock.svelte.js'

  // Only one tab works at a time (tablock.svelte.ts); the others say so instead of starting a second workspace.
  const lock = new TabLock()
  onMount(() => lock.start())
</script>

{#if lock.state === 'owner'}
  <Main />
{:else if lock.state === 'other'}
  <main class="other">
    <h1>Archiv-Editor ist schon in einem anderen Tab geöffnet</h1>
    <p>Damit sich nichts überschreibt, arbeitet immer nur ein Tab. Schließe den anderen Tab, oder arbeite hier weiter.</p>
    <button onclick={() => lock.take()}>Hier weiterarbeiten</button>
  </main>
{/if}

<style>
  .other { margin: 20vh auto 0; max-width: 28rem; padding: 0 16px; text-align: center; display: flex; flex-direction: column; gap: 12px; align-items: center; }
  .other h1 { margin: 0; font-size: 1.3rem; }
  .other p { margin: 0; color: #555; }
  button { font: inherit; padding: 8px 16px; border: 1px solid #36c; border-radius: 6px; background: #36c; color: #fff; cursor: pointer; }
</style>
