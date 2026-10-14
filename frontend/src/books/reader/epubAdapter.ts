import shell from '../../../.reader-build/shell.html?raw';
import { booksApi, aborted } from '../api';
import { ReaderDescriptor, parseLocator, record } from '../types';
import { ProgressClient } from '../progress';
import { SESSION_CHANGED_EVENT } from '../../stores/authStore';

export function mountEpubReader(frame: HTMLIFrameElement, descriptor: ReaderDescriptor, progress: ProgressClient): () => void {
  const controller = new AbortController();
  const instance = crypto.randomUUID();
  const channel = new MessageChannel();
  let connected = false;
  let active = 0;
  const outstanding = new Set<number>();
  const error = (message: string) => frame.dispatchEvent(new CustomEvent('reader-error', { detail: message }));
  const save = () => {
    if (progress.location && !controller.signal.aborted) {
      void progress.save(progress.location);
    }
  };
  channel.port1.onmessage = event => {
    if (controller.signal.aborted) return;
    let value: Record<string, unknown>;
    try { value = record(event.data); } catch { error('Reader sent an invalid message.'); return; }
    if (value.instance !== instance) return;
    if (value.type === 'error') { error('Cannot read safely here; download original.'); return; }
    if (value.type === 'location') {
      try {
        const locator = parseLocator(value.locator);
        if (locator.kind !== 'epub' || locator.policyVersion !== descriptor.policyVersion ||
            !descriptor.spine.includes(locator.resourceId)) throw new Error('Invalid location');
        progress.location = locator;
        if (value.save === true) save();
      } catch { error('Reader sent an invalid position.'); }
    } else if (value.type === 'resource') {
      const requestId = value.requestId;
      const resource = descriptor.resources.find(resource => resource.resourceId === value.resourceId);
      if (!Number.isSafeInteger(requestId) || typeof requestId !== 'number' || requestId < 1 ||
          outstanding.has(requestId) || !resource || active >= 2) {
        error('Reader requested an unavailable resource.'); return;
      }
      active += 1; outstanding.add(requestId);
      void booksApi.readerResource(descriptor.readerId, resource.resourceId, resource.size, controller.signal).then(bytes => {
        if (!controller.signal.aborted) channel.port1.postMessage({ type: 'resource-result', instance, requestId, bytes }, [bytes]);
      }).catch(failure => {
        if (!aborted(failure) && !controller.signal.aborted) {
          channel.port1.postMessage({ type: 'resource-result', instance, requestId });
          error(failure instanceof Error ? failure.message : 'Reader resource unavailable.');
        }
      }).finally(() => { active -= 1; outstanding.delete(requestId); });
    }
  };
  const boot = (event: MessageEvent) => {
    if (connected || controller.signal.aborted || event.source !== frame.contentWindow || event.data?.type !== 'epub-shell-ready') return;
    connected = true;
    frame.contentWindow!.postMessage({ type: 'epub-init', instance, descriptor, locator: progress.location }, '*', [channel.port2]);
  };
  window.addEventListener('message', boot);
  const visibility = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', save);
  const interval = window.setInterval(() => { if (document.visibilityState === 'visible') save(); }, 10000);
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = shell;
  const dispose = () => {
    controller.abort(); channel.port1.close(); channel.port2.close();
    window.clearInterval(interval);
    window.removeEventListener('message', boot);
    window.removeEventListener('pagehide', save);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener(SESSION_CHANGED_EVENT, dispose);
    frame.removeAttribute('srcdoc'); frame.src = 'about:blank';
  };
  window.addEventListener(SESSION_CHANGED_EVENT, dispose);
  return dispose;
}
