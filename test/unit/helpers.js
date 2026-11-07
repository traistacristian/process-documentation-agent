// Synthetic capture events shaped exactly like the browser extension's output.
let t = 1_700_000_000_000;
const at = () => (t += 1000);
const page = (title, hash) => ({ url: `https://admin.contoso.example/portal${hash}`, pageTitle: `${title} - Contoso Admin Portal`, app: 'Browser' });

export function v1Events() {
  t = 1_700_000_000_000;
  const users = page('Active users', '#/users'); const user = page('John Doe', '#/user/jdoe');
  return [
    { type: 'start', ts: at(), source: 'user' },
    { type: 'navigate', ts: at(), ...users, screenshotId: 'shot_aa01' },
    { type: 'key', ts: at(), ...users, text: 'Enter', element: { role: 'searchbox', label: 'Search users', name: 'Search users' } },
    { type: 'input', ts: t + 100, ...users, element: { role: 'searchbox', label: 'Search users', name: 'Search users', inputType: 'search' }, value: '[VALUE_ENTERED]' },
    { type: 'submit', ts: t + 200, ...users, element: { role: 'form', name: 'User search' } },
    { type: 'click', ts: at(), ...users, element: { role: 'gridcell', name: 'John Doe' }, screenshotId: 'shot_aa02' },
    { type: 'navigate', ts: t + 300, ...user, screenshotId: 'shot_aa03' },
    { type: 'change', ts: at(), ...user, element: { role: 'combobox', label: 'Permission level', inputType: 'select-one' }, value: 'Helpdesk administrator' },
    { type: 'click', ts: at(), ...user, element: { role: 'button', name: 'Save' }, screenshotId: 'shot_aa04' },
    { type: 'feedback', ts: t + 300, ...user, text: 'Changes saved successfully', level: 'success' },
  ].map((e, i) => ({ ...e, seq: i + 1 }));
}

export const SHOTS = new Set(['shot_aa01', 'shot_aa02', 'shot_aa03', 'shot_aa04']);
