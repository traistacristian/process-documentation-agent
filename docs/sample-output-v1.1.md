# Grant helpdesk permissions to a user

## 1. Process Information

| Field | Value |
|---|---|
| Process title | Grant helpdesk permissions to a user |
| Process ID | PRC-2026-2D0FAE |
| Version | 1.0 |
| Creation date | 2026-11-07 |
| Last updated | 2026-11-07 |
| Process owner | – |
| Responsible department | – |
| Category | – |
| Author | IT Admin |
| Reviewer / approver | IT Admin |
| Status | Published |

## 2. Purpose

Gives service desk staff the minimum admin rights they need to support users.

## 3. Scope

**Included**

- assigning helpdesk roles to internal staff

**Excluded**

- global administrator assignments

## 4. Prerequisites

**Required permissions**

- User administrator role in the admin portal

**Required access**

_To be confirmed._

**Applications and systems**

- Contoso Admin Portal

**Required information**

_To be confirmed._

**Dependencies**

_To be confirmed._

## 5. Roles and Responsibilities

- **Service desk lead**: performs the change
- **IT security**: approves privileged roles

## 6. Process Execution – Step by Step

### Step 1 – Search Active users and open the entry

Performed in Contoso Admin Portal on the "Active users" screen.

1. Open the "Active users" page (localhost:44085/portal).
2. Enter the required value in the "Search users" field and press Enter.
3. Select the relevant entry in the list.

- **Application / system:** Contoso Admin Portal
- **Required input:** Search users
- **Expected result:** The "John Doe" screen is shown.
- **Screenshot:** ![Step 1](screenshots/shot_6cf310b3ffc81feb.jpg)

### Step 2 – Save in John Doe

Performed in Contoso Admin Portal on the "John Doe" screen.

1. Select "Helpdesk administrator" in "Permission level".
2. Click "Save".

- **Application / system:** Contoso Admin Portal
- **Required input:** Permission level
- **Expected result:** The confirmation "Changes saved successfully" is displayed.
- **Screenshot:** ![Step 2](screenshots/shot_6f2e1b9bf4cdc17b.jpg)
- **Note:** Only assign helpdesk roles to staff accounts, never to guests.

## 7. Decision Points and Exceptions

_No decision points recorded._

## 8. Expected Outcome

The process is complete when: The confirmation "Changes saved successfully" is displayed.

_To be confirmed._

## 9. Troubleshooting

_No known issues recorded._

## 10. Related Documentation

_None._

## 11. Change History

| Version | Date | Author | Approver | Summary |
|---|---|---|---|---|
| 1.0 | 2026-11-07 | IT Admin | IT Admin | Initial version created from a recorded execution. |
