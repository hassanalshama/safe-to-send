import { scan } from './core/index.mjs';

self.addEventListener('message', async (event) => {
  const { id, buffer, name, type, maxBytes } = event.data;
  try {
    const report = await scan(buffer, { name, type, maxBytes });
    self.postMessage({ id, report });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
