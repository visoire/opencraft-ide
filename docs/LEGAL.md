# OpenCraft Legal Notices, Upstream Attribution, and Disclaimers

This document sets forth the legal notices, trademark disclaimers, upstream third-party engine attributions, statutory warranty disclaimers, limitation of liability, and intellectual property takedown procedures for the OpenCraft project, the OpenCraft IDE, the OpenCraft companion server, the OpenCraft website, and associated distributions.

---

## 1. Trademark and Compatibility Disclaimers

### 1.1 Independent Community Project
OpenCraft is an independent open-source community project initiated and maintained by visoire. OpenCraft is **not affiliated with, endorsed by, sponsored by, or associated with Adobe Inc., Microsoft Corporation, or any of their subsidiaries or affiliates**.

### 1.2 Ownership of Product Names, Logos, and Brands
All product names, logos, trademarks, and registered trademarks mentioned in the OpenCraft codebase, user interface, documentation, websites, or promotional materials are the property of their respective owners:
- **Microsoft Corporation**: Microsoft, Microsoft 365, Microsoft Office, Microsoft Word, Microsoft Excel, Microsoft PowerPoint, Windows, and associated logos are trademarks or registered trademarks of Microsoft Corporation in the United States and/or other countries.
- **Adobe Inc.**: Adobe, Adobe Acrobat, Adobe Photoshop, and associated logos are trademarks or registered trademarks of Adobe Inc. in the United States and/or other countries.
- **Third-Party AI Providers**: Anthropic, Claude, OpenAI, ChatGPT, Google, Gemini, DeepSeek, and Ollama are trademarks or registered trademarks of their respective owners.
- **ArtCraft Team / storytold**: ArtCraft, WordCraft, GridCraft, DeckCraft, PdfCraft, PhotoCraft, and associated engine marks and logos are the property of storytold and the ArtCraft team.

The use of any trade name, trademark, or logo within OpenCraft is solely for identification, compatibility, and descriptive purposes, and does not imply any affiliation, sponsorship, endorsement, or approval by the respective trademark owners.

### 1.3 Technical File Format Compatibility
All references to file formats—including, but not limited to, Microsoft Word document files (`.docx`, `.doc`), Microsoft Excel spreadsheet files (`.xlsx`, `.xls`, `.xlsb`), Microsoft PowerPoint presentation files (`.pptx`), and Portable Document Format files (`.pdf`)—are used **solely for technical compatibility and interoperability descriptions**. OpenCraft and its embedded engines implement independent, clean-room parsing, rendering, and generation mechanisms for these standard file formats under established principles of fair use and interoperability.

---

## 2. Upstream Engine Separation and License Attribution

### 2.1 Workspace and Engine Separation
OpenCraft maintains a strict architectural, operational, and organizational separation between the OpenCraft IDE workspace and the embedded crafting engines:

```
+---------------------------------------------------------------------------------+
|                                OpenCraft IDE                                    |
|  Workspace shell, window manager, split & picture-in-picture layouts, project   |
|  tree, local companion server (Hono on 127.0.0.1), terminal, Git integrations,  |
|  snapshots, and Model Context Protocol (MCP) orchestration layer.               |
|  License: MIT OR Apache-2.0 (github.com/visoire/opencraft-ide)                  |
+---------------------------------------------------------------------------------+
                                      |
                         Embedded as isolated iframes
                                      v
+------------------+  +------------------+  +------------------+  +------------------+
|    WordCraft     |  |    GridCraft     |  |    DeckCraft     |  |     PdfCraft     |
| Documents engine |  |  Sheets engine   |  |  Slides engine   |  |   PDFs engine    |
| (Rust -> Wasm)   |  | (Rust -> Wasm)   |  | (Rust -> Wasm)   |  |  (Rust -> Wasm)  |
+------------------+  +------------------+  +------------------+  +------------------+
  Independent open-source engines developed by storytold and the ArtCraft team
  under MIT OR Apache-2.0 (github.com/storytold)
```

1. **OpenCraft Workspace Layer**:
   - OpenCraft provides the IDE workspace shell, window management, split/dock layout, floating picture-in-picture frames, project file tree, local companion server (Node.js/Hono on `127.0.0.1`), integrated terminal, Git version control interface, project snapshot manager, and the Model Context Protocol (MCP) orchestration layer that coordinates automated workflows across applications.
   - The OpenCraft IDE is open-source software licensed under either the MIT License or the Apache License 2.0 (`MIT OR Apache-2.0`).

2. **Upstream Crafting Engines**:
   - WordCraft, GridCraft, DeckCraft, and PdfCraft are independent open-source engines developed by storytold, the ArtCraft team, and community contributors ([github.com/storytold](https://github.com/storytold)).
   - Each engine is independently licensed under the MIT License or Apache License 2.0 (`MIT OR Apache-2.0`).
   - OpenCraft distributes and embeds the official, unmodified release builds of the engines (with only documented startup patches necessary for browser environment compatibility, such as the DeckCraft 0.9.0 startup fix described in the project documentation).

3. **Maintenance of Copyright and License Notices**:
   - All upstream copyright notices, author credits, and license files are preserved intact within each application package under `versions/v9-10/web/` and when served via `/apps/<app>/`.
   - OpenCraft makes no claim of ownership or copyright over the upstream crafting engines.

---

## 3. As-Is Provision and Statutory Limitation of Liability

### 3.1 Disclaimer of Warranty ("As Is")
THE OPENCRAFT SOFTWARE, IDE, LOCAL COMPANION SERVER, DOCUMENTATION, WEBSITE, AND EMBEDDED CRAFTING ENGINES ARE PROVIDED **"AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED**, INCLUDING BUT NOT LIMITED TO:
- THE IMPLIED WARRANTIES OF MERCHANTABILITY;
- FITNESS FOR A PARTICULAR PURPOSE;
- TITLE AND NON-INFRINGEMENT;
- ANY WARRANTY THAT THE SOFTWARE WILL BE UNINTERRUPTED, TIMELY, SECURE, ACCURATE, OR ERROR-FREE;
- ANY WARRANTY REGARDING DATA LOSS, CORRUPTION, OR ROUND-TRIP FORMAT ACCURACY OF COMPLEX DOCUMENT FILES.

### 3.2 Limitation of Liability
TO THE MAXIMUM EXTENT PERMITTED UNDER APPLICABLE LAW, IN NO EVENT SHALL VISOIRE, THE ARTCRAFT TEAM, STORYTOLD, OR ANY CONTRIBUTORS, COPYRIGHT HOLDERS, OR DISTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE, THE USE OF THE SOFTWARE, OR OTHER DEALINGS IN THE SOFTWARE.

THIS LIMITATION ENCOMPASSES ALL DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGES, INCLUDING BUT NOT LIMITED TO:
- LOSS OF DATA, LOSS OF SAVED WORK, OR FILE CORRUPTION;
- LOSS OF PROFITS, REVENUE, GOODWILL, OR BUSINESS OPPORTUNITIES;
- BUSINESS INTERRUPTION, COMPUTER FAILURE, OR SYSTEM MALFUNCTION;
- UNAPPROVED ACTIONS EXECUTED VIA USER-CONFIGURED SHELL TOOLS OR MCP AUTOMATIONS;
- THIRD-PARTY AI PROVIDER ACTIONS, BILLING DISPUTES, OR API KEY EXPOSURES RESULTING FROM USER CONFIGURATION.

---

## 4. Data Privacy, Local Storage, and AI Providers

### 4.1 Strict Local Execution
- **Zero Document Uploads**: OpenCraft is designed as a local-first workspace. Local document data, spreadsheet formulas, presentation slides, code files, and PDF content remain strictly on the user's local device. They are **never sent to external servers or telemetries by OpenCraft**.
- **Local Companion Server**: The local companion server binds strictly to the loopback interface (`127.0.0.1` by default) and only serves local client sessions. When local-only mode is enabled in Settings, all external outbound network requests to cloud AI providers are blocked at the engine layer.

### 4.2 Optional Third-Party AI Providers
- **Direct Client-to-Provider Communication**: OpenCraft does not provide or broker hosted AI services. Any connection to cloud AI providers (including Anthropic, OpenAI, Google, DeepSeek, or custom OpenAI-compatible endpoints) is strictly optional.
- **User-Configured API Keys**: Third-party AI providers process only data explicitly submitted by the user through the user's configured API keys. The user's relationship with third-party AI providers is governed entirely by the terms of service, acceptable use policies, and privacy notices of those respective providers.
- **Audit Logging**: The OpenCraft IDE maintains a local audit log (`~/OpenCraft/audit.jsonl`) recording the destination, timestamp, and metadata of all outgoing AI requests for user inspection.

---

## 5. Intellectual Property, DMCA & Takedown Notices

OpenCraft respects the intellectual property rights of all content creators and rights holders, and complies with applicable copyright and trademark laws, including the Digital Millennium Copyright Act (17 U.S.C. § 512, "DMCA") and international equivalents.

If you are a copyright or trademark owner, or an authorized agent thereof, and believe that any software code, media asset, or documentation hosted or distributed by the OpenCraft project infringes upon your rights, please submit a written notification to our designated intellectual property and takedown agent:

### Designated IP & Takedown Contact
- **Recipient**: OpenCraft Legal & IP Inquiries (visoire)
- **Email**: [visoire@proton.me](mailto:visoire@proton.me)
- **Subject Line**: `[IP Notice] OpenCraft / <Entity or Brand Name>`

### Required Notice Contents
To ensure prompt processing, your written notice must include:
1. **Identification of Work**: A description of the copyrighted work, trademark, or intellectual property claimed to have been infringed.
2. **Identification of Infringing Material**: A description of where the allegedly infringing material is located within OpenCraft repositories, distributions, or websites (including exact file paths, URLs, or Git commit hashes).
3. **Contact Information**: Your full legal name, mailing address, telephone number, and email address.
4. **Good Faith Statement**: A statement that you have a good faith belief that the disputed use of the material is not authorized by the copyright/trademark owner, its agent, or the law.
5. **Accuracy and Authorization Statement**: A statement, made under penalty of perjury, that the information in the notification is accurate and that you are the owner, or authorized to act on behalf of the owner, of the exclusive right that is allegedly infringed.
6. **Signature**: A physical or electronic signature of the intellectual property owner or an authorized representative.

Upon receipt of a valid notice, we will act expeditiously to investigate, remove, disable access to, or correct the relevant material in accordance with applicable statutory procedures.

---

## 6. Repository Scope and Synchronization

This legal specification applies across all official OpenCraft repositories:
- `visoire/opencraft` (monorepo holding website and IDE sources)
- `visoire/opencraft-ide` (open-source IDE repository)
- `visoire/opencraft-home` (website repository)

Last updated: October 22, 2026
