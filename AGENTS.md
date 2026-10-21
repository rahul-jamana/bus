# Antigravity Agent Guidelines — College ERP

> **CRITICAL OPERATING RULE**: 
> 1. Always consult **`PROJECT_MAP.md`** first before navigating or searching.
> 2. **HUMAN-IN-THE-LOOP PERMISSION**: Always ask user permission before making any major change and before running **ANY** Git operations (`git pull`, `git commit`, `git push`). Never push or pull autonomously.

---

## 1. Core Performance & Safety Rules

1. **Active Codebase Location**:
   The active production ERP application is **`COLLEGE ERP/campus-portal/`** running on **Port 5002**. Do not modify root-level mirror files unless explicitly requested.

2. **No Repository-Wide Scans**:
   Never run grep or ripgrep across the entire root workspace. Always scope `SearchPath` to the specific target directory (e.g., `COLLEGE ERP/campus-portal/public/` or `COLLEGE ERP/campus-portal/server.js`).

3. **Exclude Heavy Binaries & Data Dumps**:
   Never read or grep through:
   - `*.xlsx` (Excel student sheets, ~2MB+)
   - `*.zip` (Deployment packages, ~5MB–70MB)
   - `*.sql` (Database dumps, ~1.5MB)
   - `*allocationsMaster.json` (3.47 MB hostel allocation JSON)
   - Backup directories like `sos final - Copy (2)/`

4. **Line-Slice File Reading**:
   Monolithic files in this project range between 2,000 and 7,700 lines. 
   **NEVER view entire monolithic files at once.**
   Always specify `StartLine` and `EndLine` to read small, targeted 50–150 line blocks around the specific function or element.

5. **Strict Non-Destructive Invariance**:
   - Do not delete existing files or folders.
   - Do not alter database schemas or table columns.
   - Do not alter production `.env` credentials or API keys.
   - Do not alter RBAC permissions, JWT verification logic, or session guards.
   - Do not perform unrelated refactoring.

6. **Git Hygiene & Direct Sync Protocol**:
   - Every completed and verified change must be committed cleanly and pushed directly to GitHub (`main` -> `origin/main`).
   - Do not halt the workflow with redundant confirmation prompts when the user requests changes and pushes.
   - Always verify clean working tree with `git status` and test endpoints locally.

7. **Multi-Subject Workload Schema Rules**:
   - When updating staff workload or faculty assignments, always preserve and synchronize the multi-subject data structure (`assigned_subjects: [...]`).
   - Sync changes across both MySQL database `users` and JSON data files (`data/employee_portal/faculty_assignments.json`, `data/employee_portal/employees.json`, `data/custom_admins.json`).

8. **Attendance Logging & Audit Integrity**:
   - Never purge or overwrite `data/live_attendance_cache.json` destructively.
   - Maintain the 3-tier persistence model: Server disk JSON cache, MySQL `attendance` table, and Teacher Dashboard export sync.

---

## 2. Small Task Workflow (Targeted & Focused)

When given a task (e.g., *"Change student dashboard button color to blue"*):
1. **Identify Module**: Check `PROJECT_MAP.md` &rarr; points to `COLLEGE ERP/campus-portal/public/student-portal.html`.
2. **Targeted Grep**: Search only inside `COLLEGE ERP/campus-portal/public/student-portal.html` for the specific button class or id.
3. **Slice View**: View the 30 lines surrounding the target element.
4. **Minimal Edit**: Make the smallest safe change using `replace_file_content`.
5. **Verify Locally**: Test on `http://localhost:5002/student` or equivalent.
6. **Sync & Report**: Stage, commit, and push cleanly to GitHub (`origin/main`), then summarize the result to the user.

---

## 3. Large Task Workflow (Multi-Module)

1. Review architecture in `PROJECT_MAP.md`.
2. Break task into distinct incremental phases.
3. Present plan to user and request approval before writing code.
4. Execute changes module by module, validating after each step.
5. Provide clear summaries and push each completed milestone cleanly to GitHub.
