import React, { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { booksApi, aborted, booksErrorMessage } from './api';
import { BooksSettingsState } from './types';

export const BooksSettings: React.FC = () => {
  const sessionRevision = useAuthStore(state => state.sessionRevision);
  const [settings, setSettings] = useState<BooksSettingsState>();
  const [origin, setOrigin] = useState('');
  const [credential, setCredential] = useState('');
  const [binding, setBinding] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setSettings(undefined); setOrigin(''); setCredential(''); setConfirmed(false); setError(''); setMessage('');
    void booksApi.settings(controller.signal).then(value => {
      setSettings(value); setEnabled(value.enabled); setBinding(value.serverBindingProofId ?? '');
    }).catch(error => { if (!aborted(error)) setError(booksErrorMessage(error)); });
    return () => controller.abort();
  }, [sessionRevision]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await booksApi.saveSettings({
        enabled, libraryId: settings.libraryId, serverBindingProofId: binding,
        restrictedPrincipalConfirmed: confirmed,
        ...(origin ? { origin } : {}), ...(credential ? { credential } : {}),
      });
      setSettings(result); setCredential(''); setOrigin(''); setMessage('Books settings saved');
    } catch (error) { if (!aborted(error)) setError(booksErrorMessage(error)); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(''); setMessage('');
    try { await booksApi.verifySettings(); setMessage('Books connection verified'); }
    catch (error) { if (!aborted(error)) setError(booksErrorMessage(error)); }
    finally { setBusy(false); }
  };
  return (
    <section className="card mt-6 p-4 md:p-6" aria-labelledby="books-settings-heading">
      <h2 id="books-settings-heading" className="text-xl font-semibold md:text-2xl">Books connection</h2>
      <p className="mt-3 text-sm leading-6 text-gray-400">
        The selected ABS library is shared with every authorized LibraryDownloadarr user. Books remains separate from Plex downloads.
        Use a restricted, non-admin ABS principal with download access and no update, delete, or upload permissions.
      </p>
      {settings ? <form className="mt-5 space-y-4" onSubmit={event => void save(event)}>
        <p className="text-sm text-gray-300">Credential: {settings.configured ? 'configured (never returned)' : 'not configured'}</p>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" checked={enabled} disabled={!settings.deploymentEnabled || busy} onChange={event => setEnabled(event.target.checked)} />
          Enable Books
        </label>
        {!settings.deploymentEnabled && <p className="text-sm text-amber-300">The deployment flag BOOKS_ENABLED is off. Enabling requires separate operator approval.</p>}
        <label className="block text-sm">Selected library
          <input className="input mt-1 min-h-11" value={settings.libraryId} readOnly />
        </label>
        <label className="block text-sm">ABS origin
          <input className="input mt-1 min-h-11" type="url" value={origin} autoComplete="off"
            placeholder={settings.configured ? 'Configured - leave empty to keep' : 'https://your-abs-origin'}
            onChange={event => setOrigin(event.target.value)} />
        </label>
        <label className="block text-sm">ABS credential
          <input className="input mt-1 min-h-11" type="password" value={credential} autoComplete="new-password"
            placeholder={settings.configured ? 'Leave empty to keep the protected credential' : 'Protected ABS credential'}
            onChange={event => setCredential(event.target.value)} />
        </label>
        <label className="block text-sm">Server binding proof ID
          <input className="input mt-1 min-h-11" value={binding} required pattern="[A-Za-z0-9_-]+" maxLength={200}
            onChange={event => setBinding(event.target.value)} />
        </label>
        <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
          <input className="mt-1" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          I verified this server binding and the restricted principal's effective library and download permissions.
        </label>
        <div className="flex flex-wrap gap-3">
          <button type="submit" className="btn-primary min-h-11" disabled={busy || (enabled && !confirmed)}>Save Books settings</button>
          <button type="button" className="btn-secondary min-h-11" disabled={busy || !settings.configured} onClick={() => void verify()}>Verify Books connection</button>
        </div>
      </form> : !error && <p role="status" className="mt-4 text-sm text-gray-400">Loading Books settings...</p>}
      {error && <p role="alert" className="mt-4 rounded bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
      {message && <p role="status" className="mt-4 rounded bg-emerald-500/10 p-3 text-sm text-emerald-200">{message}</p>}
    </section>
  );
};
