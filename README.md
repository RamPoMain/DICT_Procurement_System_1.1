# 🏛️ DICT Procurement Management System

[![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)](https://vitejs.dev/)
[![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)](https://react.dev/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/)
=======

A centralized web application developed for the **Department of Information and Communications Technology (DICT)** to prepare, manage, approve, and consolidate **Project Procurement Management Plans (PPMP)** and compile **Annual Procurement Plans (APP)** in compliance with Philippine procurement laws (**Republic Act No. 12009 — New Government Procurement Act**).

---

## 📋 Features & Capabilities

### 1. PPMP Management & 3-Step Wizard
- **3-Step Guided Form**: Form wizard validating *Project Details*, *Timeline Sequence*, and *Funding & Supporting Documents*.
- **Multi-Item Grouping**: Multiple line items grouped under one official PPMP number per office.
- **Reference Number Engine**: Auto-generates standardized reference numbers per category (`<Year>-GDS-####`, `<Year>-INF-####`, `<Year>-CSV-####`, `<Year>-GEN-####`).
- **Multi-Item Navigator**: Browse, view, and update line items within a saved PPMP without leaving the modal.

### 2. Philippine Procurement Rules (RA 12009 Compliance)
- **Automated Two Failed Biddings Detection (Sec. 33)**: 
  - Cross-references project descriptions across approved PPMP records for the requesting office.
  - Automatically locks the 3rd attempt to **Negotiated Procurement – Two Failed Biddings** with **Negotiated** evaluation criteria.
  - Automatically prepends and tags previous attempts with `[1st Failure]` and `[2nd Failure]`.
- **Budget Threshold & Bracket Enforcement**:
  - **Direct Acquisition (Sec. 32)**: Up to ₱200,000.00 for NGAs.
  - **Small Value Procurement (SVP) (Sec. 31)**: ₱200,001.00 to ₱2,000,000.00.
  - **Shopping (Sec. 30)**: Up to ₱2,000,000.00 (restricted strictly to *Goods*).
  - **Competitive Bidding (Sec. 15)**: ₱2,000,000.00 and above (or any eligible amount).
- **Milestone Date Sequencing**: Strict chronological date validation (`Advertisement/Posting` -> `Bid Opening` -> `Notice of Award` -> `Contract Signing` -> `Delivery Period`).
- **Deduplicated Total Budget**: Multiple re-bidding attempts sharing the same reference number count only once toward the total budget.
- **Parallel Planning Lanes**: Requesting offices can maintain an active *Final* PPMP (current year) and an *Indicative* PPMP (next year) in parallel.
- **Fiscal Year Rollover**: When the APP of a fiscal year is finalized and marked Complete by the Regional Director, the year is automatically closed against new requests, and subsequent requests default to the next open year.

### 3. Multi-Stage Approval Workflows
- **PPMP Chain**: `Requesting Unit / Unit Head` -> `TOD (Technical Operations Division)` -> `Budget Officer` -> `RD (Regional Director)`.
  - *Unit Head Submissions*: Automatically bypass the HEAD stage and endorse directly to TOD with an automated remark log.
- **APP Master Workflow**:
  - Compiled and monitored by the **Supply Account (`SUP`)**.
  - Endorsed by the **Assistant Regional Director (`ARD`)**.
  - Final approval and marking as Final by the **Regional Director (`RD`)**.
- **Audit Trails**: Full review history tracking approver role, date, decision (Approve / Reject / Remark), and mandatory returned remarks.

### 4. Native Storage & Large File Management
- **IndexedDB `FileStore`**: Stores up to 50MB of raw document blobs (PDFs, Scope of Work, Technical Specs) natively in the browser without filling `localStorage`.
- **System Persistence**: State persistence for dark/light themes, offline sessions, and sequential approval logs.

### 5. Document Generation & Export Engines
- **GPPB-Compliant PDF Generator**:
  - Official PPMP printout with multi-item layout and 3-column signature block.
  - Automated APP PDF assembly with automated category routing:
    - General Administration and Support Services (GASS) -> *Common Supplies and Equipment (CSE)*.
    - Direct Acquisition -> *Miscellaneous Items (Sec. 32.2)*.
    - All other items -> *General Requirements*.
- **ExcelJS Styled Spreadsheets**:
  - Single PPMP `.xlsx` download formatted to official government templates.
  - Master Entries export packaging all filtered PPMPs into dedicated sheets in one workbook.
  - Official DBM APP Template export (`.xlsx`) with embedded `=SUM()` and `=MOOE + CO` formulas.
- **Bulk Import**:
  - Excel template generator with drop-down data validation and instruction guides.
  - Multi-row template parser via SheetJS with row-by-row error diagnostics.

---

## 💻 Tech Stack

- **Framework**: React 18+
- **Build Tool**: Vite
- **Routing**: React Router DOM v6
- **Spreadsheet Processing**: ExcelJS & SheetJS (xlsx)
- **PDF Generation**: jsPDF & jsPDF-AutoTable
- **Local Database**: IndexedDB (Native Blob API) + LocalStorage

---

## 🚀 Getting Started

### Prerequisites

Ensure you have **Node.js (v18.0.0 or higher)** and **npm** installed on your system.

```bash
node -v
npm -v
<<<<<<< HEAD
```

### Installation

1. Clone the repository:
```bash
git clone https://github.com/RamPoMain/DICT_Procurement_System.git
cd DICT_Procurement_System
```

2. Install dependencies:
```bash
npm install
```

### Running Locally

Start the local development server:
```bash
npm run dev
```

Open your browser and navigate to:
```text
http://localhost:3000/
```

### Testing DTMS document sending

The **Test DTMS Send** button appears while viewing a PPMP or APP. It uploads a PDF marked `[TEST]` through the server proxy using the configured signer accounts in `src/utils/dtmsClient.js`. A successful test send creates a real DTMS document and can notify those accounts, but it does not change the local approval status.

Configure `server/.env` from `server/env.example.txt` with the DTMS base URL, API key, registered DTMS origin, and the web app origin (`http://localhost:3000` for the local Vite app). Add any other exact browser origins to the optional comma-separated `APP_ORIGINS` value. Keep the API key only in `server/.env`. Then install and start the proxy from the `server` directory with `npm install` and `npm start`; restart the proxy after changing its environment settings, and run the web app separately with `npm run dev`.

PPMPs use a one-stage-at-a-time handoff: the requester submits to DTMS for the Department Head's signature; after the signed PDF returns to the Procurement System, TOD reviews it in the system and sends it to DTMS for TOD's signature; Budget Officer then reviews and sends it for their DTMS signature; the final signed copy returns to the system for the RD's local approval. APP submissions currently route Supply, ARD, then RD together for sequential DTMS signatures. The Entries page polls DTMS every 45 seconds and rechecks when the browser regains focus; sync failures are shown in the page notification. After each PPMP signing stage, it stores the signed PDF in browser IndexedDB, where it can be previewed and downloaded from the PPMP view. Set each signer to the correct active DTMS account in `src/utils/dtmsClient.js` before production; the current local configuration temporarily points all steps to the same DTMS account. Because this app currently stores records in browser `localStorage` and files in browser IndexedDB, these updates are only available in that browser; multi-user deployment needs shared server-side persistence.

### Building for Production

To create an optimized production build:
```bash
npm run build
```

To preview the production build locally:
```bash
npm run preview
```

---

## 🔐 Default Test Accounts

All accounts use the default password: **`1`**

| Role / Bureau | Office / Designation | Email Address | Permissions |
| :--- | :--- | :--- | :--- |
| **ILCDB** | ICT Literacy Competency & Development Bureau | `ILCDB@dict.gov.ph` | Create/Edit PPMP Requests |
| **FPIAP** | Free Public Internet Access Program | `FPIAP@dict.gov.ph` | Create/Edit PPMP Requests |
| **GASS** | General Administration & Support Services | `GASS@dict.gov.ph` | Create/Edit PPMP Requests |
| **ILCDB Head** | Unit Head (ILCDB) | `ILCDBHEAD@dict.gov.ph` | Create PPMP & Auto-Endorse to TOD |
| **FPIAP Head** | Unit Head (FPIAP) | `FPIAPHEAD@dict.gov.ph` | Create PPMP & Auto-Endorse to TOD |
| **GASS Head** | Unit Head (GASS) | `GASSHEAD@dict.gov.ph` | Create PPMP & Auto-Endorse to TOD |
| **TOD** | Technical Operations Division Chief | `tod@dict.gov.ph` | Review & Endorse Stage 2 PPMP |
| **Budget Officer** | Budget Office | `BudgetOfficer@dict.gov.ph` | Review & Certify Funds (Stage 3) |
| **ARD** | Assistant Regional Director | `ard@dict.gov.ph` | Endorse Master APP / PPMP Review |
| **RD** | Regional Director | `rd@dict.gov.ph` | Final PPMP & Final APP Approval |
| **Suppliers** | Supply & Procurement Unit | `suppliers@dict.gov.ph` | Track Requests & Compile Master APP |
| **POP Test** | Test Account | `test@dict.gov.ph` | General Request Testing |

---

## 📁 Project Directory Structure

```text
dict-procurement-react/
├── public/
│   └── images/
│       └── header-banner.png       # Official DICT Header Banner
├── src/
│   ├── assets/
│   │   └── styles/                 # Application styles (CSS)
│   ├── context/
│   │   ├── AuthContext.jsx         # Authentication, accounts, & permissions
│   │   └── ThemeContext.jsx        # Dark / Light theme state
│   ├── utils/
│   │   ├── fileStore.js            # IndexedDB document storage
│   │   ├── procurementRules.js     # RA 12009 rules, failed biddings & calculations
│   │   ├── pdfGenerator.js         # jsPDF PPMP & APP generators
│   │   ├── entriesExport.js        # ExcelJS styled PPMP workbooks
│   │   ├── appTemplateExport.js    # DBM APP official template export
│   │   └── bulkImport.js           # Excel upload parser & template builder
│   ├── components/
│   │   ├── layout/
│   │   │   └── Sidebar.jsx         # Navigation sidebar & session controls
│   │   └── modals/
│   │       ├── RequestModal.jsx    # 3-step PPMP creation & view wizard
│   │       └── AppPreviewModal.jsx # APP review & decision modal
│   ├── pages/
│   │   ├── Login.jsx               # Authentication portal
│   │   ├── Dashboard.jsx           # Statistics, activity & quick actions
│   │   ├── Entries.jsx             # PPMP and APP interactive tables
│   │   └── Profile.jsx             # User credentials & account details
│   ├── App.jsx                     # Route definitions & security guards
│   └── main.jsx                    # Application entry point
├── index.html                      # Root HTML shell
├── package.json
└── vite.config.js
```
=======
>>>>>>> d703a5171ffcb4016025f1cc3ee6f29e604d0af1
