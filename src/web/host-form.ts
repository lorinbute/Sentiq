// Sentiq.iOS FD-V3-S19 (TD-V3-S19): an indicator's settings drawn by the iOS app. The page's own forms (StudySettings,
// the Slingshot / LMA form) keep their draft and every rule; in the app they also describe themselves (`form`) and take
// the app's edits back (`formSet`, `formSave`, `formDefaults`, `formTab`), so the native sheet changes exactly what the
// drawer would. In a browser none of this runs.
import { useEffect, useRef } from 'react';
import { sendToHost, useEmbedCommands, useHostReport } from './embed.ts';

export { HostSetters, hostNumber, hostString, hostStyle, type HostColor, type HostField, type HostForm, type HostGroup, type HostLineStyle } from './host-form-model.ts';
import type { HostForm, HostSetters } from './host-form-model.ts';

/**
 * While `active` (in the app), tells the app the form (and `null` once it is gone) and runs the app's edits on it. The
 * setters and actions are read at the command's time: the latest render's.
 */
export function useHostForm(active: boolean, form: HostForm | null, setters: HostSetters, actions: { save: () => void; defaults: () => void; tab?: (t: 'inputs' | 'style') => void }): void {
  useHostReport(active, 'form', form);
  useEffect(() => (active ? () => sendToHost('form', null) : undefined), [active]);
  const ref = useRef({ setters, actions });
  ref.current = { setters, actions };
  useEmbedCommands(active, (c) => {
    if (c.type === 'formSet') ref.current.setters.set(c.key, c.value);
    else if (c.type === 'formSave') ref.current.actions.save();
    else if (c.type === 'formDefaults') ref.current.actions.defaults();
    else if (c.type === 'formTab') ref.current.actions.tab?.(c.tab);
  });
}
