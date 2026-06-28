<script lang="ts">
  import { marked, type Token } from 'marked';
  import MarkdownNode from './MarkdownNode.svelte';

  const { text }: { text: string } = $props();

  // Lex to tokens only — never render raw HTML. `breaks` keeps single newlines
  // (commit bodies hard-wrap); `gfm` enables tables / task lists / strikethrough.
  const tokens = $derived<Token[]>(
    text ? (marked.lexer(text, { gfm: true, breaks: true }) as Token[]) : [],
  );
</script>

<div class="md-root"><MarkdownNode {tokens} /></div>

<style>
  .md-root { white-space: normal; word-break: break-word; }
  .md-root :global(.md-p:first-child) { margin-top: 0; }
  .md-root :global(.md-heading:first-child) { margin-top: 0; }
</style>
