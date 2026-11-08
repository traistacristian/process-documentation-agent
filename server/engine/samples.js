// Realistic sample processes for demos and first-time visitors. An administrator adds them on
// purpose (Administration → Demo content); they are published like any other document and marked
// with the category "Sample" so they are easy to find and delete again.
import { normalizeDoc } from './schema.js';

const S = (title, application, instructions, expectedResult, extra = {}) => ({ title, application, instructions, expectedResult, description: '', input: '', notes: [], warnings: [], important: false, ...extra });

const SAMPLES = [
  {
    title: 'Reset a user\'s password', department: 'Service Desk', owner: 'Service Desk Lead',
    purpose: 'Gives a user who is locked out or has forgotten the password access again within minutes, without weakening account security.',
    scope: { included: ['Cloud accounts in Microsoft Entra ID', 'Requests by phone, ticket or walk-in'], excluded: ['Administrator and break-glass accounts', 'Accounts synchronised from on-premises AD (reset there)'] },
    prerequisites: { permissions: ['Helpdesk Administrator or Password Administrator role'], access: ['Microsoft 365 admin center'], systems: ['Microsoft 365 admin center', 'Ticketing system'], information: ['Ticket number', 'User principal name'], dependencies: [] },
    roles: [{ role: 'Service desk agent', responsibilities: 'Verifies the caller and resets the password' }, { role: 'User', responsibilities: 'Sets a new password at the next sign-in' }],
    steps: [
      S('Verify the caller', 'Ticketing system', ['Ask for the employee number and the manager\'s name.', 'Compare them with the details in the ticketing system.'], 'The identity of the caller is confirmed.', { important: true, warnings: ['Never reset a password before the identity is verified.'] }),
      S('Open the user', 'Microsoft 365 admin center', ['Open Users > Active users.', 'Search for the user and select the name.'], 'The user details panel is shown.'),
      S('Reset the password', 'Microsoft 365 admin center', ['Click "Reset password".', 'Keep "Automatically create a password" and "Require this user to change their password when they first sign in" selected.', 'Click "Reset password".'], 'A temporary password is shown.', { input: 'None (password generated automatically)' }),
      S('Hand over the temporary password', 'Phone', ['Tell the user the temporary password by phone, never by e-mail or chat.'], 'The user signs in and chooses a new password.'),
      S('Close the ticket', 'Ticketing system', ['Document "Password reset, identity verified by …" in the ticket.', 'Set the ticket to Resolved.'], 'The ticket is resolved.'),
    ],
    decisions: [{ condition: 'the caller cannot be verified', action: 'do not reset; ask the manager to confirm by e-mail', stepNumber: 1 }],
    exceptions: [{ problem: '"Reset password" is greyed out', handling: 'The account is synchronised from on-premises AD; reset it in Active Directory Users and Computers.', escalation: 'Second-level support' }],
    expectedOutcome: 'The user can sign in again with a new password of their own choice.',
    verification: ['The user confirms a successful sign-in.', 'The sign-in log shows a successful sign-in after the reset.'],
    troubleshooting: [{ issue: 'User is still locked out', resolution: 'Wait 5 minutes for the smart lockout to clear, then try again.' }],
  },
  {
    title: 'Create a new employee account', department: 'IT Operations', owner: 'Head of IT Operations',
    purpose: 'Makes sure every new employee has a working account, the right licence and the right groups on their first day.',
    scope: { included: ['Permanent and temporary employees'], excluded: ['External contractors (guest process)', 'Shared mailboxes'] },
    prerequisites: { permissions: ['User Administrator role', 'License Administrator role'], access: ['Microsoft 365 admin center'], systems: ['Microsoft 365 admin center', 'HR system'], information: ['Approved onboarding request from HR', 'Start date, department, manager'], dependencies: ['A free Microsoft 365 licence'] },
    roles: [{ role: 'HR', responsibilities: 'Sends the approved onboarding request' }, { role: 'IT operations', responsibilities: 'Creates the account and assigns licence and groups' }, { role: 'Manager', responsibilities: 'Receives the first-day sign-in details' }],
    steps: [
      S('Check the onboarding request', 'HR system', ['Open the onboarding request.', 'Check that it is approved and contains department, manager and start date.'], 'All mandatory details are present.', { important: true }),
      S('Add the user', 'Microsoft 365 admin center', ['Open Users > Active users and click "Add a user".', 'Enter first name, last name and display name.', 'Use the username format firstname.lastname.'], 'The basics page is complete.', { input: 'Name, username' }),
      S('Assign the licence', 'Microsoft 365 admin center', ['Select the location "Austria" or the country of employment.', 'Select the licence "Microsoft 365 Business Premium".'], 'The licence is selected.'),
      S('Set job details', 'Microsoft 365 admin center', ['Open "Profile info" and enter job title, department and manager.', 'Click "Finish adding".'], 'The account is created and a temporary password is shown.'),
      S('Add the user to groups', 'Microsoft 365 admin center', ['Open the user > Groups > Manage groups.', 'Add the department group and "All employees".'], 'The user is a member of the required groups.'),
      S('Send the sign-in details', 'Outlook', ['Send username and temporary password to the manager in two separate messages.'], 'The manager has the first-day sign-in details.', { warnings: ['Never send username and password in the same message.'] }),
    ],
    decisions: [{ condition: 'no licence is free', action: 'request one from the licence owner before the start date', stepNumber: 3 }],
    exceptions: [{ problem: 'Username already exists', handling: 'Add the middle initial (firstname.m.lastname).', escalation: 'IT operations lead' }],
    expectedOutcome: 'The new employee can sign in on the first day and has e-mail, Teams and access to the department files.',
    verification: ['The account shows the correct licence.', 'The user appears in the department group.'],
    troubleshooting: [{ issue: 'Mailbox not available yet', resolution: 'Mailbox creation can take up to 30 minutes after the licence is assigned.' }],
  },
  {
    title: 'Offboard a leaving employee', department: 'IT Operations', owner: 'Head of IT Operations',
    purpose: 'Removes access on the last working day so that company data stays protected, while keeping the mailbox for the manager.',
    scope: { included: ['Employees leaving the company'], excluded: ['Internal transfers (change groups only)'] },
    prerequisites: { permissions: ['User Administrator role', 'Exchange Administrator role'], access: ['Microsoft 365 admin center'], systems: ['Microsoft 365 admin center', 'HR system'], information: ['Approved leaver request from HR', 'Last working day'], dependencies: [] },
    roles: [{ role: 'HR', responsibilities: 'Sends the leaver request' }, { role: 'IT operations', responsibilities: 'Blocks the account and converts the mailbox' }, { role: 'Manager', responsibilities: 'Receives access to the mailbox and files' }],
    steps: [
      S('Block sign-in', 'Microsoft 365 admin center', ['Open the user and click "Block sign-in".', 'Select "Block this user from signing in" and save.'], 'The user can no longer sign in.', { important: true }),
      S('Sign the user out everywhere', 'Microsoft 365 admin center', ['On the user, click "Sign out of all sessions".'], 'All active sessions are ended.'),
      S('Convert the mailbox', 'Microsoft 365 admin center', ['Open the Mail tab and click "Convert to shared mailbox".', 'Give the manager read access.'], 'The mailbox is a shared mailbox the manager can open.'),
      S('Remove the licence', 'Microsoft 365 admin center', ['Open "Licenses and apps" and clear all licences.', 'Click "Save changes".'], 'The licence is free again.'),
      S('Close the request', 'HR system', ['Mark the leaver request as completed with the date.'], 'HR sees the request as completed.'),
    ],
    decisions: [{ condition: 'the employee is leaving with immediate effect', action: 'block sign-in at once, before the remaining steps', stepNumber: 1 }],
    exceptions: [], expectedOutcome: 'The former employee has no access; the manager can read the mailbox; the licence is free.',
    verification: ['Sign-in is shown as blocked.', 'The licence count went down by one.'], troubleshooting: [],
  },
  {
    title: 'Grant access to a shared mailbox', department: 'Service Desk', owner: 'Service Desk Lead',
    purpose: 'Gives a user approved access to a team mailbox such as info@ or invoices@.',
    scope: { included: ['Read and send-as permissions on shared mailboxes'], excluded: ['Personal mailboxes of other users'] },
    prerequisites: { permissions: ['Exchange Administrator role'], access: ['Microsoft 365 admin center'], systems: ['Microsoft 365 admin center'], information: ['Approval of the mailbox owner'], dependencies: [] },
    roles: [{ role: 'Mailbox owner', responsibilities: 'Approves the request' }, { role: 'Service desk agent', responsibilities: 'Assigns the permission' }],
    steps: [
      S('Check the approval', 'Ticketing system', ['Check that the mailbox owner approved the request in the ticket.'], 'The approval is documented.', { important: true }),
      S('Open the shared mailbox', 'Microsoft 365 admin center', ['Open Teams & groups > Shared mailboxes and select the mailbox.'], 'The mailbox details panel is shown.'),
      S('Add the member', 'Microsoft 365 admin center', ['Under Members, click "Edit" and then "Add members".', 'Select the user and click "Add".'], 'The user is listed as a member.'),
      S('Inform the user', 'Ticketing system', ['Tell the user that the mailbox appears in Outlook within about an hour.', 'Resolve the ticket.'], 'The ticket is resolved.'),
    ],
    decisions: [{ condition: 'the user also needs to send as the mailbox', action: 'add "Send as" permission under Mailbox permissions', stepNumber: 3 }],
    exceptions: [], expectedOutcome: 'The user sees the shared mailbox in Outlook and can work with it.',
    verification: ['The user confirms the mailbox is visible.'], troubleshooting: [{ issue: 'Mailbox not visible in Outlook', resolution: 'Restart Outlook; automapping can take up to 60 minutes.' }],
  },
];

export function sampleDocs({ user, newProcessId }) {
  const now = new Date().toISOString();
  return SAMPLES.map(({ title, department, owner, steps, ...rest }) => normalizeDoc({
    ...rest,
    info: { processId: newProcessId(), title, version: '1.0', createdAt: now, updatedAt: now, owner, department, category: 'Sample', author: user.name, approver: user.name, status: 'Published', language: 'en', fileName: title.replace(/[^\w .-]/g, '') },
    steps: steps.map((s, i) => ({ ...s, id: `stp_sample_${i + 1}`, number: i + 1, screenshotIds: [], evidenceEventSeqs: [], targets: [] })),
    related: [], changeHistory: [{ version: '1.0', date: now, author: user.name, approver: user.name, summary: 'Sample process for demonstrations' }],
  }));
}
