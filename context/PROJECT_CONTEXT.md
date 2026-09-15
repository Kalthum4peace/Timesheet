# Kalthum for Peace Automated Timesheet System

## Project Status

This is a real client project for **Kalthum for Peace**.

The goal is to replace the organization's current manual monthly timesheet process with a simple web-based system.

The requirements below were gathered directly from discussions with the organization's Senior Program Manager (SPM).

This document represents the current confirmed understanding of the project.

---

# 1. PRODUCT OVERVIEW

The system is an internal monthly timesheet and approval platform.

The existing timesheet is extremely simple.

A staff member provides:

- Name
- Location
- Month
- Daily attendance status

The available daily statuses are:

- Present
- Absent
- Public Holiday
- Leave

The system's complexity comes from the organizational workflow rather than the timesheet itself.

The system must handle:

- Authentication
- Staff accounts
- Departments
- Organizational hierarchy
- Monthly timesheets
- Daily attendance
- Approval workflow
- Conditional approval permissions
- Self-approval prevention
- Decline/return workflow
- Resubmission
- Email notifications
- In-app notifications
- Audit history
- Reports/exports
- Searchable archive
- Role-based access
- Database-level security

This is NOT intended to be:

- A payroll system
- A biometric attendance system
- A full HRIS
- A complex workforce management platform
- A time-clock system

Keep the product focused.

---

# 2. ORGANIZATION

The organization currently has two relevant departments:

1. Medical
2. Operations

The organizational hierarchy is:

```text
Staff
  ↓
Team Lead
  ↓
Department Head
  ↓
Final Review
```

---

# 3. ORGANIZATIONAL RULES

These have been confirmed:

### Staff → Team Lead

- Each staff member has one Team Lead at a given time.
- One Team Lead can supervise many staff members.

### Team Lead → Department Head

- Team Leads belong to a department.
- A Department Head can supervise multiple Team Leads.

There are currently:

- Head of Medical
- Head of Operations

These should preferably be represented through one application role:

`department_head`

with department determining which department they manage.

### Assignment

The **System Admin** manages:

- Staff assignments
- Team Lead assignments
- Department assignments
- Department Head assignments

### Historical changes

Organizational relationships can change over time.

Example:

```text
January–March
John → Team Lead A → Head of Medical

April onward
John → Team Lead B → Head of Operations
```

Historical timesheets must not change when organizational relationships change.

Therefore, the approval chain for a timesheet should be captured when the timesheet enters the approval process.

---

# 4. USER ROLES

## Staff

Can:

- Log in
- Create monthly timesheet
- Select month
- Enter daily attendance
- Save draft
- Submit
- View own timesheets
- View status
- View comments
- View approval history
- Edit returned timesheets
- Resubmit returned timesheets

Cannot:

- Approve
- Decline
- Edit submitted/locked timesheets
- Edit approved/archived timesheets
- Access another staff member's timesheets

---

## Team Lead

Can:

- View assigned staff timesheets
- Review timesheets
- Approve
- Decline with comment
- View approval history
- Acknowledge returned timesheets

Cannot:

- Edit staff timesheets
- Approve their own timesheet

---

## Department Head

There are:

- Head of Medical
- Head of Operations

Can:

- View relevant department timesheets
- Approve
- Decline with comment
- View approval history
- Acknowledge returned timesheets

Cannot:

- Edit submitted timesheets
- Approve their own timesheet

---

# 5. SENIOR PROGRAM MANAGER

The SPM has conditional permissions.

## Medical

For Medical timesheets:

**SPM is view-only.**

SPM cannot approve or decline Medical timesheets.

## Operations

For Operations timesheets:

**SPM is an approver.**

However:

**SPM cannot approve their own timesheet.**

When the SPM's own Operations timesheet is being processed:

- SPM is view-only
- HR approves

---

# 6. HR

HR has broad access.

HR can:

- View all staff timesheets
- Approve
- Decline with comment
- View approval history
- Acknowledge returned timesheets
- Generate reports
- Search archive

HR cannot approve their own timesheet.

When HR's own Operations timesheet is being processed:

- HR becomes view-only
- SPM approves

---

# 7. SYSTEM ADMIN

The System Admin manages system configuration.

Can:

- Create users
- Deactivate users
- Assign roles
- Assign departments
- Assign Team Leads
- Assign Department Heads
- Change reporting relationships
- Manage system settings
- View audit information

Important:

The Admin should NOT automatically be able to approve or edit timesheets.

Administrative privileges and approval privileges should remain separate.

---

# 8. TIMESHEET

Each staff member gets:

**One timesheet per month.**

There must be a database constraint preventing duplicate timesheets for the same staff member and month/year.

Example:

```text
John Doe
September 2026
→ one timesheet only
```

Timesheet information:

- Staff
- Location
- Department
- Month
- Year
- Daily attendance

---

# 9. DAILY ATTENDANCE

Each calendar day has one status:

```text
Present
Absent
Public Holiday
Leave
```

Use normalized records.

Do NOT create:

```text
day_1
day_2
day_3
...
day_31
```

Instead use:

```text
attendance_entries

timesheet_id
date
status
```

There must be a uniqueness constraint preventing two attendance entries for the same date on the same timesheet.

---

# 10. BASE APPROVAL WORKFLOW

Every submitted timesheet follows:

```text
Staff
 ↓
Team Lead
 ↓
Department Head
 ↓
Final Review
 ↓
Approved
 ↓
Archived
```

A submitted timesheet becomes locked.

The staff member cannot edit it while it is moving through approval.

---

# 11. MEDICAL WORKFLOW

For Medical staff:

```text
Staff
 ↓
Team Lead
 ↓
Head of Medical
 ↓
HR
 ↓
Approved
 ↓
Archived
```

SPM has view-only access.

HR is the final approver.

---

# 12. OPERATIONS WORKFLOW

For a normal Operations staff member:

```text
Staff
 ↓
Team Lead
 ↓
Head of Operations
 ↓
SPM + HR
 ↓
Approved
 ↓
Archived
```

Both SPM and HR must approve.

If one has approved and the other has not:

```text
PENDING
```

The timesheet only becomes approved once all required approvals are complete.

---

# 13. SELF-APPROVAL PREVENTION

No user may approve their own timesheet.

This must be enforced in backend/business logic and should not depend solely on hiding UI buttons.

### SPM's own Operations timesheet

```text
Staff/Team Lead
 ↓
Head of Operations
 ↓
HR → Approves
SPM → View only
 ↓
Approved
```

### HR's own Operations timesheet

```text
Staff/Team Lead
 ↓
Head of Operations
 ↓
SPM → Approves
HR → View only
 ↓
Approved
```

---

# 14. DECLINE / RETURN WORKFLOW

When an approver declines a timesheet:

The timesheet enters a return process.

It does NOT immediately become editable by the staff member.

It travels backward through the approval chain.

Each person receiving the returned timesheet:

- Can view it
- Can see the decline comment
- Acknowledges the return
- Cannot edit the timesheet

Eventually the timesheet reaches the staff member.

The staff member can then:

- Edit
- Correct
- Resubmit

When resubmitted, the approval process starts again from the beginning.

---

# 15. RETURN EXAMPLES

### Team Lead declines

```text
Team Lead declines
 ↓
Staff receives return
 ↓
Staff edits
 ↓
Staff resubmits
 ↓
Team Lead reviews again
```

### Department Head declines

```text
Department Head declines
 ↓
Team Lead acknowledges return
 ↓
Staff receives return
 ↓
Staff edits
 ↓
Staff resubmits
```

### Final approver declines

The timesheet travels backward through the relevant approval chain until it reaches the staff member.

The return path should be based on the actual approval steps associated with that timesheet.

---

# 16. AUDIT HISTORY

Never delete previous workflow history.

Example:

```text
Submission #1
Team Lead → Approved
Head → Approved
HR → Declined

Return process

Staff edits

Submission #2
Team Lead → Approved
Head → Approved
HR → Approved
```

Both attempts remain in the audit history.

The timesheet has one current state, while its historical actions remain preserved.

---

# 17. DATABASE ARCHITECTURE

Initial proposed tables:

## profiles

```text
id
full_name
email
location
department
role
active
created_at
updated_at
```

`id` references Supabase Auth.

Passwords are handled by Supabase Auth.

---

## organizational_assignments

```text
id
staff_id
team_lead_id
department_head_id
department
effective_from
effective_to
created_by
created_at
```

Purpose:

Preserve organizational reporting relationships over time.

---

## timesheets

```text
id
staff_id
department
month
year
status
submitted_at
approved_at
created_at
updated_at
```

Required constraint:

```text
UNIQUE(staff_id, month, year)
```

---

## attendance_entries

```text
id
timesheet_id
date
status
created_at
updated_at
```

Required constraint:

```text
UNIQUE(timesheet_id, date)
```

---

## approval_steps

Represents the actual approval chain for a specific timesheet.

Example:

```text
Timesheet #123

1. Team Lead → Mary → Approved
2. Department Head → John → Approved
3. SPM → David → Approved
4. HR → Sarah → Pending
```

Proposed fields:

```text
id
timesheet_id
step_order
approver_id
approval_type
status
comment
acted_at
created_at
```

This is critical because the current organizational structure may change later.

The timesheet should remember who was assigned to approve it when the workflow began.

---

## timesheet_actions

Permanent audit history.

Possible actions:

```text
SUBMITTED
APPROVED
DECLINED
RETURN_ACKNOWLEDGED
EDITED
RESUBMITTED
```

Fields:

```text
id
timesheet_id
actor_id
action
comment
created_at
```

---

## notifications

Fields:

```text
id
recipient_id
timesheet_id
type
title
message
read_at
email_sent_at
created_at
```

Supports both in-app and email notifications.

---

# 18. ARCHIVE

Do NOT create a separate archive table unless a strong technical reason emerges.

Approved timesheets remain in the `timesheets` table.

The Archive is a filtered/read-only view of completed timesheets.

Potential filters:

- Staff
- Department
- Month
- Year
- Team Lead
- Department Head
- Status

---

# 19. TIMESHEET STATES

Primary states:

```text
DRAFT
PENDING_TEAM_LEAD
PENDING_DEPARTMENT_HEAD
PENDING_FINAL_REVIEW
RETURNING
APPROVED
ARCHIVED
```

Do not create unnecessary states.

Detailed approval status should be represented in `approval_steps`.

---

# 20. SECURITY REQUIREMENTS

Supabase Row Level Security is mandatory.

Frontend filtering is NOT sufficient for authorization.

## Staff

Can only access their own timesheets and related data.

Can edit only their own draft/returned timesheets.

## Team Lead

Can access timesheets belonging to staff currently assigned to them.

Historical approval access must remain available where appropriate.

## Department Head

Can access relevant department timesheets.

## HR

Can access all timesheets.

## SPM

Access depends on department and approval rules.

Medical:

- View only

Operations:

- Approver unless it is the SPM's own timesheet

## Admin

Can manage users and organizational configuration.

Do not automatically give unrestricted timesheet editing/approval permissions.

---

# 21. BACKEND APPROVAL VALIDATION

Approval operations must be validated server-side.

An approval action should verify:

1. User is authenticated.
2. User is authorized for the specific approval step.
3. User is not approving their own timesheet.
4. Timesheet is in the expected state.
5. Previous required steps are complete.
6. User has not already acted on the step.
7. Action is recorded.
8. Appropriate notifications are triggered.

Do not trust the frontend to enforce these rules.

---

# 22. NOTIFICATIONS

Both:

- In-app notifications
- Email notifications

are required.

Relevant events include:

- Timesheet submitted
- Approval required
- Approved
- Declined
- Returned
- Return acknowledged
- Resubmitted
- Final approval

Email failure should not corrupt the main workflow.

The database/workflow remains the source of truth.

Supabase Edge Functions or another appropriate backend mechanism can be used for email delivery.

---

# 23. REPORTING

Reports/exports are required.

Potential reports:

- Monthly attendance
- Staff timesheets
- Department timesheets
- Pending approvals
- Approved timesheets
- Declined/returned timesheets

Potential formats:

- Excel
- PDF

Do not overbuild reporting until exact organizational reporting requirements are established.

---

# 24. UI

The system should be simple and professional.

## Staff screens

- Login
- Dashboard
- My Timesheet
- Timesheet History
- Notifications

## Approver screens

- Dashboard
- Pending Approvals
- Timesheet Detail
- Approval History
- Returned Items

## HR

- All Timesheets
- Pending Approvals
- Reports
- Archive

## SPM

- Relevant Timesheets
- Operations approvals
- Medical view-only access

## Admin

- Dashboard
- Users
- Departments
- Reporting Relationships
- Roles
- Audit Logs
- Settings

---

# 25. TIMESHEET UI

The timesheet should feel like a digital version of the existing manual form.

Conceptually:

```text
Name: John Doe
Location: Maiduguri
Department: Operations

September 2026

Mon Tue Wed Thu Fri Sat Sun
 1   2   3   4   5   6   7
 P   P   P   L   P   -   -

 8   9  10  11  12  13  14
 P   P   A   P   P   -   -

...

Legend:
P  = Present
A  = Absent
L  = Leave
PH = Public Holiday

[Save Draft]    [Submit Timesheet]
```

The actual interface should be designed for non-technical staff and require minimal training.

---

# 26. INFRASTRUCTURE

Preferred architecture:

```text
timesheet.kalthum4peace.org
          ↓
       Vercel
          ↓
      Supabase
          ↓
PostgreSQL + Auth + RLS
```

### Domain

The organization already owns:

`kalthum4peace.org`

Preferred subdomain:

`timesheet.kalthum4peace.org`

No separate subdomain purchase is required.

DNS configuration will be required.

Do not modify MX records because existing organizational email must continue working.

### Hosting

Frontend:

Vercel or equivalent.

### Database/Auth

Supabase.

### SSL

Handled by hosting infrastructure.

No separate SSL purchase should be necessary.

### Email

The organization already has official business email accounts.

Existing email infrastructure can be reused where appropriate.

---

# 27. DEVELOPMENT PRINCIPLES

The system should be:

- Simple
- Secure
- Maintainable
- Production-ready
- Understandable by one developer
- Appropriate for an internal organization

Avoid:

- Overengineering
- Unnecessary microservices
- Excessive abstraction
- Unnecessary dependencies
- Generic HR features
- Features not required by the client

---

# 28. IMPORTANT ARCHITECTURAL PRINCIPLES

### Current state vs history

The current timesheet status belongs in `timesheets`.

Detailed approval history belongs in `approval_steps` and `timesheet_actions`.

Do not attempt to make one field perform all three jobs.

### Historical relationships

Current organizational assignments can change.

Historical timesheets must retain the approval chain that applied when they were submitted.

### Authorization

Permissions must be enforced server-side/database-side.

### Immutability

Once approved/archived, a timesheet should be treated as immutable.

### Resubmission

Resubmission should not destroy the previous submission history.

---

# 29. CURRENT BUILD SEQUENCE

The recommended implementation sequence is:

## Phase 1
Architecture review.

Identify:

- Contradictions
- Missing edge cases
- Security risks
- Workflow risks
- Schema problems
- Scalability problems

Clearly label:

- Confirmed Requirement
- Recommendation
- Open Decision
- Assumption

---

## Phase 2
Finalize PostgreSQL schema.

Produce:

- Tables
- Enums
- Foreign keys
- Constraints
- Indexes
- Relationships
- Historical relationship handling

---

## Phase 3
Design Supabase RLS.

Map every role against every relevant table.

---

## Phase 4
Implement workflow engine.

Implement:

- Submission
- Approval
- Decline
- Return
- Acknowledgement
- Editing
- Resubmission
- Final approval

---

## Phase 5
Implement notifications.

---

## Phase 6
Build UI.

---

## Phase 7
Reports and exports.

---

## Phase 8
Testing.

Especially test:

- Self-approval
- Cross-department access
- Team Lead access
- Historical reporting relationships
- Decline/return workflow
- Resubmission
- Concurrent approvals
- Duplicate monthly timesheets
- Unauthorized API access

---

## Phase 9
Deployment.

Expected production architecture:

```text
User
 ↓
timesheet.kalthum4peace.org
 ↓
Vercel
 ↓
Supabase
 ↓
PostgreSQL
```

---

# 30. CURRENT PROJECT STATUS

Requirements gathering is substantially complete.

Confirmed:

- Timesheet structure
- Attendance statuses
- Monthly frequency
- Departments
- Organizational hierarchy
- User roles
- Approval workflow
- Medical workflow
- Operations workflow
- SPM/HR self-approval rules
- Decline/return behavior
- Resubmission
- Audit history requirement
- Notifications
- Archive
- Reporting requirement
- Infrastructure direction

The next immediate task is:

**Architecture review → final database schema → Supabase RLS → workflow implementation.**

Do not restart requirements gathering unless a genuine contradiction or missing requirement is discovered during implementation.