/* ---- kopiert aus <script> block in databank.html ---- */
/* Alle Funktionen, Variablen und Logik aus der Originaldatei wurden 1:1 übernommen. */

 // Global variables
 let db = null;
 let currentTable = null;
 let selectedElement = null;
 let sqlEditor = null;
 
 // ER Diagram specific variables (from old.html concept)
 let schema = { tables: {} }; // parsed schema with relationships
 let tablePositions = {}; // stored positions for table cards
 let dragState = null; // for dragging table cards
 
 // Pan and Zoom variables
 let panState = { isDragging: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };
 let zoomLevel = 1;
 let minZoom = 0.3;
 let maxZoom = 3;

 // Initialize application (avoid name clash with library's window.initSqlJs loader)
 async function initApp() {
     try {
         // If SQL already initialized, skip loader
         if (!window.SQL) {
             const loader = window.initSqlJs; // original library loader
             if (typeof loader !== 'function') {
                 throw new Error('sql.js loader (window.initSqlJs) not available');
             }
             const SQL = await loader({
                 locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
             });
             window.SQL = SQL;
         }

         // Create empty database if not exists
         if (!db) {
             db = new window.SQL.Database();
             updateStatus('Database initialized - Ready to import data');

             // Create sample data for demo
             createSampleData();
             loadTreeView();
         }

         // Setup drag & drop (idempotent)
         setupDragAndDrop();

         // Initialize SQL Editor with syntax highlighting
         initSqlEditor();

     } catch (error) {
         updateStatus(`Failed to initialize: ${error.message}`);
         console.error('Initialization error:', error);
     }
 }

 // Initialize SQL Editor with CodeMirror
 function initSqlEditor() {
     if (!window.CodeMirror) {
         console.warn('CodeMirror not loaded, using plain textarea');
         return;
     }

     const textarea = document.getElementById('sqlEditor');
     if (!textarea || sqlEditor) return; // Already initialized

     sqlEditor = CodeMirror.fromTextArea(textarea, {
         mode: 'text/x-sql',
         theme: 'monokai',
         lineNumbers: true,
         autoCloseBrackets: true,
         matchBrackets: true,
         indentWithTabs: true,
         smartIndent: true,
         lineWrapping: true,
         extraKeys: {
             'Ctrl-Enter': executeSql,
             'Cmd-Enter': executeSql,
             'Tab': function(cm) {
                 cm.replaceSelection('    ');
             }
         }
     });

     // Set dark theme colors to match app
     sqlEditor.getWrapperElement().style.backgroundColor = 'var(--bg-tertiary)';
 }

 // Setup drag and drop functionality
 function setupDragAndDrop() {
     const dropZone = document.querySelector('.file-drop-zone');
     
     if (!dropZone) return;
     
     ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
         dropZone.addEventListener(eventName, preventDefaults, false);
         document.body.addEventListener(eventName, preventDefaults, false);
     });
     
     ['dragenter', 'dragover'].forEach(eventName => {
         dropZone.addEventListener(eventName, highlight, false);
     });
     
     ['dragleave', 'drop'].forEach(eventName => {
         dropZone.addEventListener(eventName, unhighlight, false);
     });
     
     dropZone.addEventListener('drop', handleDrop, false);
     
     function preventDefaults(e) {
         e.preventDefault();
         e.stopPropagation();
     }
     
     function highlight(e) {
         dropZone.style.background = 'var(--accent)';
         dropZone.style.color = 'white';
     }
     
     function unhighlight(e) {
         dropZone.style.background = 'var(--bg-tertiary)';
         dropZone.style.color = 'var(--text-primary)';
     }
     
     function handleDrop(e) {
         const dt = e.dataTransfer;
         const files = dt.files;
         handleFileSelect(files);
     }
 }

 // Create sample data
 function createSampleData() {
     db.run(`
         CREATE TABLE IF NOT EXISTS customers (
             id INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             email TEXT UNIQUE,
             created_at DATETIME DEFAULT CURRENT_TIMESTAMP
         );
     `);
     
     db.run(`
         CREATE TABLE IF NOT EXISTS orders (
             id INTEGER PRIMARY KEY,
             customer_id INTEGER,
             product_name TEXT,
             amount DECIMAL(10,2),
             order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
             FOREIGN KEY(customer_id) REFERENCES customers(id)
         );
     `);

     // Insert sample data
     db.run("INSERT INTO customers (name, email) VALUES ('John Doe', 'john@email.com')");
     db.run("INSERT INTO customers (name, email) VALUES ('Jane Smith', 'jane@email.com')");
     db.run("INSERT INTO orders (customer_id, product_name, amount) VALUES (1, 'Laptop', 999.99)");
     db.run("INSERT INTO orders (customer_id, product_name, amount) VALUES (2, 'Mouse', 29.99)");
 }

 // Load tree view
 function loadTreeView() {
     const treeView = document.getElementById('treeView');
     if (!db) {
         treeView.innerHTML = '<div class="loading"><div class="spinner"></div><p>No database loaded</p></div>';
         return;
     }

     const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
     let html = '<div class="tree-item" onclick="selectDatabase()"><span class="tree-icon">🗄️</span>Database</div>';
     
     if (tables.length > 0 && tables[0].values.length > 0) {
         html += '<div class="tree-children">';
         tables[0].values.forEach(([tableName]) => {
             html += `
                 <div class="tree-item" onclick="selectTable('${tableName}')">
                     <span class="tree-icon">📊</span>${tableName}
                 </div>
             `;
         });
         html += '</div>';
     }

     treeView.innerHTML = html;
     updateStatus(`Database loaded with ${tables[0]?.values?.length || 0} tables`);
     
     // Also refresh schema for ER diagram
     refreshSchema();
 }

 // Select table
 function selectTable(tableName) {
     currentTable = tableName;
     // Clear existing actives
     document.querySelectorAll('.tree-item').forEach(item => item.classList.remove('active'));
     // Highlight correct tree item
     const treeItems = document.querySelectorAll('.tree-item');
     treeItems.forEach(item => {
         // item text may contain emoji/icon, so use includes
         if (item.textContent.trim().endsWith(tableName) || item.textContent.trim() === tableName) {
             item.classList.add('active');
         }
     });
     loadTableData(tableName);
     updateProperties(tableName);
     refreshSchema(); // This will re-render the ER diagram with updated selection
 }

 // Load table data (with improved rowid mapping & editing)
 function loadTableData(tableName) {
     const container = document.querySelector('#table-view .table-container');
     
     try {
         const result = db.exec(`SELECT rowid, * FROM ${tableName}`);
                 
         if (result.length === 0) {
             container.innerHTML = '<div class="loading"><p>No data found in table</p></div>';
             return;
         }

         const columns = result[0].columns.slice(1); // exclude rowid synthetic column
         const rows = result[0].values;
         const maxDisplayRows = 1000; // Limit for performance
         const displayRows = rows.slice(0, maxDisplayRows);

         let html = `
             <div style="margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                 <span style="color: var(--text-secondary); font-size: 14px;">
                     Showing ${displayRows.length} of ${rows.length} rows
                 </span>
                 <button class="btn" onclick="addNewRow('${tableName}')">➕ Add Row</button>
             </div>
             <table class="data-table">
                 <thead>
                     <tr>
         ${columns.map(col => `<th>${col}</th>`).join('')}
                         <th>Actions</th>
                     </tr>
                 </thead>
                 <tbody>
         `;

         displayRows.forEach((row, rowIndex) => {
             const rowid = row[0];
             html += `<tr data-rowid="${rowid}">`;
             row.slice(1).forEach((cell, colIndex) => {
                 const cellValue = cell !== null ? String(cell).replace(/"/g, '&quot;') : '';
                 html += `<td><input type="text" class="editable" value="${cellValue}" 
                     onchange="updateCell('${tableName}', ${rowid}, '${columns[colIndex]}', this.value)"></td>`;
             });
             html += `<td><button class="btn" onclick="deleteRow('${tableName}', ${rowid})">🗑️</button></td>`;
             html += '</tr>';
         });

         html += `
                 </tbody>
             </table>
             <button class="btn btn-primary" onclick="addNewRow('${tableName}')" style="margin-top: 10px;">➕ Add Row</button>
         `;

         container.innerHTML = html;
         updateStatus(`Loaded table: ${tableName} (${rows.length} rows)`);
     } catch (error) {
         container.innerHTML = `<div class="loading"><p>Error loading table: ${error.message}</p></div>`;
         updateStatus(`Error: ${error.message}`);
     }
 }

 // Update cell value with basic type handling
 function updateCell(tableName, rowid, columnName, newValue) {
     try {
         // Get column type
         const info = db.exec(`PRAGMA table_info(${tableName})`);
         let colType = '';
         if (info.length) {
             const row = info[0].values.find(r => r[1] === columnName);
             if (row) colType = (row[2] || '').toLowerCase();
         }
         let value = newValue.trim();
         if (value === '') value = null;
         else if (/int|real|numeric|double|decimal/.test(colType)) {
             const num = Number(value);
             if (isNaN(num)) throw new Error('Expected numeric value');
             value = num;
         }
         db.run(`UPDATE ${tableName} SET ${columnName} = ? WHERE rowid = ?`, [value, rowid]);
         updateStatus(`Updated ${tableName}.${columnName}`);
         refreshSchema();
     } catch (error) {
         updateStatus(`Error updating cell: ${error.message}`);
         console.warn('Cell update error', error);
     }
 }

 // Add new row (skip PK columns and use NULL for numeric types)
 function addNewRow(tableName) {
     try {
         const tableInfo = db.exec(`PRAGMA table_info(${tableName})`);
         if (!tableInfo.length) throw new Error('Cannot read schema');
         const cols = tableInfo[0].values; // cid, name, type, notnull, dflt_value, pk
         const insertable = cols.filter(c => c[5] !== 1); // skip primary key
         const names = insertable.map(c => c[1]);
         const placeholders = names.map(()=>'?').join(',');
         const values = insertable.map(c => {
             const t = (c[2]||'').toLowerCase();
             if (/int|real|numeric|double|decimal/.test(t)) return null; // numeric defaults NULL
             return '';
         });
         if (!names.length) throw new Error('No insertable columns');
         db.run(`INSERT INTO ${tableName} (${names.join(',')}) VALUES (${placeholders})`, values);
         loadTableData(tableName);
         updateStatus(`Added new row to ${tableName}`);
         refreshSchema();
     } catch (error) {
         updateStatus(`Error adding row: ${error.message}`);
         console.warn('Add row error', error);
     }
 }

 // Delete row (rowid passed directly now)
 function deleteRow(tableName, rowid) {
     if (!confirm('Delete this row?')) return;
     try {
         db.run(`DELETE FROM ${tableName} WHERE rowid = ?`, [rowid]);
         loadTableData(tableName);
         updateStatus(`Deleted row from ${tableName}`);
         refreshSchema();
     } catch (error) {
         updateStatus(`Error deleting row: ${error.message}`);
     }
 }

 // Switch tabs
 function switchTab(tabName) {
     document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
     document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
     
     event.target.classList.add('active');
     document.getElementById(tabName).classList.add('active');
     
     if (tabName === 'er-diagram') {
         setTimeout(() => {
             renderERDiagram();
             updateStatus('ER Diagram - Right-click + drag to pan, scroll to zoom, double-click to reset view');
         }, 100);
     }
 }

 // ========== Schema Extraction (from old.html) ==========
 function refreshSchema() {
     schema = { tables: {} };
     if (!db) {
         renderERDiagram();
         return;
     }
     
     const res = db.exec("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'");
     if (!res || res.length === 0) {
         schema.tables = {};
         renderERDiagram();
         return;
     }
     
     // res is an array; columns in res[0].columns, values in res[0].values
     const rows = res[0].values.map(r => {
         const obj = {};
         res[0].columns.forEach((c,i) => obj[c] = r[i]);
         return obj;
     });
     
     rows.forEach(r => {
         const name = r.name;
         const type = r.type;
         const createSql = r.sql;
         
         // get columns
         const info = db.exec(`PRAGMA table_info('${name.replace(/'/g,"''")}')`);
         let cols = [];
         if (info && info[0]) {
             const infoRows = info[0].values.map(v => {
                 const o = {}; 
                 info[0].columns.forEach((c,i) => o[c] = v[i]); 
                 return o;
             });
             cols = infoRows.map(c => ({
                 name: c.name, 
                 type: c.type, 
                 notnull: c.notnull, 
                 pk: c.pk, 
                 dflt_value: c.dflt_value
             }));
         }
         
         // get foreign keys
         let fks = [];
         try {
             const fk = db.exec(`PRAGMA foreign_key_list('${name.replace(/'/g,"''")}')`);
             if (fk && fk[0]) {
                 const fkRows = fk[0].values.map(v => {
                     const o = {}; 
                     fk[0].columns.forEach((c,i) => o[c] = v[i]); 
                     return o;
                 });
                 fks = fkRows.map(f => ({
                     from_col: f.from,
                     to_table: f.table,
                     to_col: f.to, 
                     on_update: f.on_update, 
                     on_delete: f.on_delete
                 }));
             }
         } catch(e) { /* ignore */ }

         schema.tables[name] = { name, type, createSql, cols, fks };
     });

     renderERDiagram();
 }

 // ========== ER Diagram Rendering (from old.html) ==========
 function renderERDiagram() {
     const canvasEl = document.getElementById('erCanvas');
     const svgEl = document.getElementById('erSvgOverlay');
     
     // Initialize pan and zoom events (only once)
     if (!canvasEl.dataset.eventsInitialized) {
         initializePanZoom();
         canvasEl.dataset.eventsInitialized = 'true';
     }
     
     // Clear existing table cards
     Array.from(canvasEl.querySelectorAll('.table-card')).forEach(n => n.remove());
     
     // Clear SVG
     while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
     
     if (!db || Object.keys(schema.tables).length === 0) {
         canvasEl.innerHTML = '<svg class="er-svg-overlay" id="erSvgOverlay"></svg><div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: var(--text-secondary);">No tables to display</div>';
         return;
     }
     
     // Create table cards
     let left = 40;
     let top = 40;
     Object.values(schema.tables).forEach((t, idx) => {
         const card = document.createElement('div');
         card.className = 'table-card';
         card.dataset.name = t.name;
         
         // Position: restore or assign grid positions
         const pos = tablePositions[t.name] || {
             x: left + (idx % 3) * 320, 
             y: top + Math.floor(idx / 3) * 180
         };
         tablePositions[t.name] = pos;
         card.style.left = pos.x + 'px';
         card.style.top = pos.y + 'px';
         
         // Header
         const header = document.createElement('div');
         header.className = 'tbl-header';
         header.innerHTML = `
             <div class="tbl-title">${escapeHtml(t.name)}</div>
             <div class="tbl-count">${t.cols.length}</div>
         `;
         
         // Body
         const body = document.createElement('div');
         body.className = 'tbl-body';
         body.innerHTML = t.cols.map(c => {
             const pkClass = c.pk ? ' col-pk' : '';
             const fkClass = t.fks.some(fk => fk.from_col === c.name) ? ' col-fk' : '';
             return `
                 <div class="col-item${pkClass}${fkClass}">
                     <div class="col-name">${escapeHtml(c.name)}</div>
                     <div class="col-type">${escapeHtml(c.type || '')}</div>
                 </div>
             `;
         }).join('');
         
         card.appendChild(header);
         card.appendChild(body);

         // Events
         card.addEventListener('mousedown', tableCardMouseDown);
         card.addEventListener('dblclick', () => { 
             selectTable(t.name);
             switchTab('table-view');
         });
         card.addEventListener('click', () => {
             // Remove selection from other cards
             document.querySelectorAll('.table-card').forEach(c => c.classList.remove('selected'));
             card.classList.add('selected');
             showTableDetails(t.name);
         });

         canvasEl.appendChild(card);
     });

     // Apply current transform
     updateCanvasTransform();

     // Draw all connectors after a brief delay to ensure DOM is ready
     setTimeout(drawAllConnectors, 50);
 }

 // ========== Pan and Zoom Functionality ==========
 function initializePanZoom() {
     const diagramEl = document.querySelector('.er-diagram');
     const canvasEl = document.getElementById('erCanvas');
     
     // Right-click drag for panning
     diagramEl.addEventListener('mousedown', (e) => {
         if (e.button === 2 || e.ctrlKey) { // Right click or Ctrl+click
             e.preventDefault();
             panState.isDragging = true;
             panState.startX = e.clientX - panState.offsetX;
             panState.startY = e.clientY - panState.offsetY;
             diagramEl.style.cursor = 'grabbing';
         }
     });

     diagramEl.addEventListener('mousemove', (e) => {
         if (panState.isDragging) {
             e.preventDefault();
             panState.offsetX = e.clientX - panState.startX;
             panState.offsetY = e.clientY - panState.startY;
             updateCanvasTransform();
         }
     });

     diagramEl.addEventListener('mouseup', (e) => {
         if (panState.isDragging) {
             panState.isDragging = false;
             diagramEl.style.cursor = 'grab';
         }
     });

     // Prevent context menu on right click
     diagramEl.addEventListener('contextmenu', (e) => {
         e.preventDefault();
     });

     // Zoom with scroll wheel
     diagramEl.addEventListener('wheel', (e) => {
         e.preventDefault();
         
         const rect = diagramEl.getBoundingClientRect();
         const centerX = rect.width / 2;
         const centerY = rect.height / 2;
         
         const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
         const newZoom = Math.max(minZoom, Math.min(maxZoom, zoomLevel * scaleFactor));
         
         if (newZoom !== zoomLevel) {
             // Zoom towards center
             const zoomRatio = newZoom / zoomLevel;
             panState.offsetX = centerX - (centerX - panState.offsetX) * zoomRatio;
             panState.offsetY = centerY - (centerY - panState.offsetY) * zoomRatio;
             
             zoomLevel = newZoom;
             updateCanvasTransform();
             
             // Redraw connectors after zoom
             setTimeout(drawAllConnectors, 50);
         }
     });

     // Reset view on double-click
     diagramEl.addEventListener('dblclick', (e) => {
         if (e.target === diagramEl || e.target === canvasEl) {
             resetView();
         }
     });
 }

 function updateCanvasTransform() {
     const canvasEl = document.getElementById('erCanvas');
     const backgroundSize = 20 * zoomLevel;
     
     canvasEl.style.transform = `translate(${panState.offsetX}px, ${panState.offsetY}px) scale(${zoomLevel})`;
     canvasEl.style.backgroundSize = `${backgroundSize}px ${backgroundSize}px`;
     
     // Update SVG overlay size
     const svgEl = document.getElementById('erSvgOverlay');
     if (svgEl) {
         svgEl.style.transform = `translate(${panState.offsetX}px, ${panState.offsetY}px) scale(${zoomLevel})`;
     }
 }

 function resetView() {
     panState.offsetX = 0;
     panState.offsetY = 0;
     zoomLevel = 1;
     updateCanvasTransform();
     setTimeout(drawAllConnectors, 50);
     updateStatus('View reset to default position and zoom');
 }

 // ========== Table Card Dragging (from old.html) ==========
 function tableCardMouseDown(e) {
     // Only allow dragging with left mouse button and not when panning
     if (e.button === 0 && !e.ctrlKey && e.target.closest('.tbl-header')) {
         e.preventDefault();
         e.stopPropagation();
         
         const el = e.currentTarget;
         const rect = el.getBoundingClientRect();
         const canvasRect = document.getElementById('erCanvas').getBoundingClientRect();
         
         // Calculate position relative to canvas, accounting for zoom and pan
         const canvasX = (rect.left - canvasRect.left - panState.offsetX) / zoomLevel;
         const canvasY = (rect.top - canvasRect.top - panState.offsetY) / zoomLevel;
         
         dragState = {
             el, 
             startX: e.clientX, 
             startY: e.clientY, 
             origX: canvasX,
             origY: canvasY
         };
         document.addEventListener('mousemove', tableCardMouseMove);
         document.addEventListener('mouseup', tableCardMouseUp);
     }
 }

 function tableCardMouseMove(e) {
     if (!dragState) return;
     
     // Calculate movement in canvas coordinates
     const dx = (e.clientX - dragState.startX) / zoomLevel;
     const dy = (e.clientY - dragState.startY) / zoomLevel;
     
     const nx = Math.max(0, dragState.origX + dx);
     const ny = Math.max(0, dragState.origY + dy);
     
     dragState.el.style.left = nx + 'px';
     dragState.el.style.top = ny + 'px';
     tablePositions[dragState.el.dataset.name] = {x: nx, y: ny};
     
     drawAllConnectors();
 }

 function tableCardMouseUp(e) {
     document.removeEventListener('mousemove', tableCardMouseMove);
     document.removeEventListener('mouseup', tableCardMouseUp);
     dragState = null;
 }

 // ========== Draw Foreign Key Connectors (from old.html) ==========
 function drawAllConnectors() {
     const svgEl = document.getElementById('erSvgOverlay');
     if (!svgEl) return;
     
     // Clear existing connectors
     while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
     
     // For each table, for each foreign key, draw line from table->target
     Object.values(schema.tables).forEach(t => {
         t.fks.forEach(fk => {
             const fromEl = document.querySelector(`.table-card[data-name="${cssEscape(t.name)}"]`);
             const toEl = document.querySelector(`.table-card[data-name="${cssEscape(fk.to_table)}"]`);
             if (!fromEl || !toEl) return;
             
             const p1 = getCardAnchor(fromEl, fk.from_col);
             const p2 = getCardAnchor(toEl, fk.to_col);
             drawConnector(p1, p2, fk);
         });
     });
 }


        function getCardAnchor(cardEl, colName) {
            // Find column index to set vertical offset
            const cols = Array.from(cardEl.querySelectorAll('.col-item'));
            let idx = 0;
            for (let i = 0; i < cols.length; i++) {
                const name = cols[i].querySelector('.col-name')?.textContent || '';
                if (name === colName) { 
                    idx = i; 
                    break; 
                }
            }
            
            // Get position directly from element styles (already in canvas coordinates)
            const x = parseInt(cardEl.style.left || 0) + 260; // right edge of card (card width = 260px)
            const y = parseInt(cardEl.style.top || 0) + 50 + idx * 28; // 50 header + per-col
            
            return {x, y};
        }

        function drawConnector(p1, p2, fk) {
            const svgEl = document.getElementById('erSvgOverlay');
            const svgNS = "http://www.w3.org/2000/svg";
            
            // Update SVG size to match canvas
            const canvasEl = document.getElementById('erCanvas');
            const diagramEl = document.querySelector('.er-diagram');
            svgEl.setAttribute('width', diagramEl.offsetWidth);
            svgEl.setAttribute('height', diagramEl.offsetHeight);
            
            // Create curved path
            const path = document.createElementNS(svgNS, 'path');
            const dx = Math.abs(p2.x - p1.x);
            const curv = Math.min(160, dx / 2 + 20);
            const d = `M${p1.x},${p1.y} C ${p1.x + curv},${p1.y} ${p2.x - curv},${p2.y} ${p2.x},${p2.y}`;
            
            path.setAttribute('d', d);
            path.setAttribute('stroke', 'rgba(96,165,250,0.9)');
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke-width', Math.max(1, 2 / zoomLevel)); // Adjust stroke width for zoom
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('style', 'filter:drop-shadow(0 2px 6px rgba(96,165,250,0.08));');
            svgEl.appendChild(path);
            
            // Arrow marker
            const marker = document.createElementNS(svgNS, 'circle');
            marker.setAttribute('cx', p2.x);
            marker.setAttribute('cy', p2.y);
            marker.setAttribute('r', Math.max(2, 4 / zoomLevel)); // Adjust marker size for zoom
            marker.setAttribute('fill', 'rgba(96,165,250,0.95)');
            svgEl.appendChild(marker);
        }

        // ========== Utility Functions ==========
        function escapeHtml(s) { 
            if (s == null) return ''; 
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); 
        }
        
        function cssEscape(s) { 
            return s.replace(/"/g,'\\"'); 
        }

        function showTableDetails(name) {
            const t = schema.tables[name];
            if (!t) return;
            
            // Update properties panel with table details
            const propertiesContent = document.getElementById('propertiesContent');
            
            let html = `
                <div class="property-group">
                    <div class="property-label">Table Name</div>
                    <input type="text" class="property-value" value="${escapeHtml(name)}" readonly>
                </div>
                <div class="property-group">
                    <div class="property-label">Type</div>
                    <input type="text" class="property-value" value="${escapeHtml(t.type || 'table')}" readonly>
                </div>
                <div class="property-group">
                    <div class="property-label">Columns</div>
                    <input type="text" class="property-value" value="${t.cols.length} columns" readonly>
                </div>
                <div class="property-group">
                    <div class="property-label">Foreign Keys</div>
                    <input type="text" class="property-value" value="${t.fks.length} foreign keys" readonly>
                </div>
                <div class="property-group">
                    <div class="property-label">CREATE Statement</div>
                    <textarea class="property-value" rows="6" readonly>${escapeHtml(t.createSql || '')}</textarea>
                </div>
            `;
            
            propertiesContent.innerHTML = html;
        }

        // Replacement for old drawERDiagram function
        function drawERDiagram() {
            refreshSchema();
        }

        // Execute SQL
        function executeSql() {
            const resultsDiv = document.getElementById('sqlResults');
            let query;
            
            if (sqlEditor) {
                query = sqlEditor.getValue().trim();
            } else {
                query = document.getElementById('sqlEditor').value.trim();
            }
            
            if (!query) {
                resultsDiv.innerHTML = '<p style="color: var(--text-secondary);">Please enter a SQL query</p>';
                return;
            }

            const startTime = performance.now();
            
            try {
                // Handle multiple statements
                const statements = query.split(';').filter(stmt => stmt.trim());
                let totalResults = [];
                let executedCount = 0;
                
                statements.forEach((statement, index) => {
                    const trimmedStatement = statement.trim();
                    if (trimmedStatement) {
                        try {
                            const result = db.exec(trimmedStatement);
                            if (result.length > 0) {
                                totalResults.push({
                                    statement: trimmedStatement,
                                    result: result[0],
                                    index: index + 1
                                });
                            }
                            executedCount++;
                        } catch (stmtError) {
                            totalResults.push({
                                statement: trimmedStatement,
                                error: stmtError.message,
                                index: index + 1
                            });
                        }
                    }
                });
                
                const endTime = performance.now();
                const executionTime = (endTime - startTime).toFixed(2);
                
                if (totalResults.length === 0) {
                    resultsDiv.innerHTML = `
                        <div style="background: var(--success); color: white; padding: 15px; border-radius: 8px; margin-top: 10px;">
                            <strong>Success:</strong> ${executedCount} statement(s) executed successfully (${executionTime}ms)
                        </div>
                    `;
                    loadTreeView(); // Refresh tree view in case structure changed
                    return;
                }
                
                let html = `<div style="background: var(--bg-secondary); border-radius: 8px; padding: 15px; margin-top: 10px;">
                    <div style="margin-bottom: 15px; font-size: 14px; color: var(--text-secondary);">
                        Execution time: ${executionTime}ms | Statements: ${executedCount}
                    </div>`;
                
                totalResults.forEach((queryResult, index) => {
                    if (index > 0) html += '<hr style="border: 1px solid var(--border); margin: 20px 0;">';
                    
                    if (queryResult.error) {
                        html += `
                            <div style="background: var(--error); color: white; padding: 10px; border-radius: 4px; margin-bottom: 10px;">
                                <strong>Statement ${queryResult.index} Error:</strong> ${queryResult.error}
                                <br><code style="font-size: 12px; opacity: 0.8;">${queryResult.statement}</code>
                            </div>
                        `;
                    } else {
                        html += `
                            <div style="margin-bottom: 15px;">
                                <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 5px;">
                                    Statement ${queryResult.index}: <code>${queryResult.statement}</code>
                                </div>
                                <table class="data-table">
                                    <thead>
                                        <tr>
                                            ${queryResult.result.columns.map(col => `<th>${col}</th>`).join('')}
                                        </tr>
                                    </thead>
                                    <tbody>
                        `;
                        
                        queryResult.result.values.forEach(row => {
                            html += '<tr>';
                            row.forEach(cell => {
                                html += `<td>${cell !== null ? cell : '<span style="color: var(--text-muted);">NULL</span>'}</td>`;
                            });
                            html += '</tr>';
                        });
                        
                        html += `
                                    </tbody>
                                </table>
                                <p style="color: var(--text-secondary); margin-top: 5px; font-size: 12px;">
                                    ${queryResult.result.values.length} rows returned
                                </p>
                            </div>
                        `;
                    }
                });
                
                html += '</div>';
                resultsDiv.innerHTML = html;
                
                const totalRows = totalResults.reduce((sum, r) => {
                    return sum + (r.result ? r.result.values.length : 0);
                }, 0);
                
                updateStatus(`Query executed - ${totalRows} rows returned in ${executionTime}ms`);
                
                // Refresh views if structure might have changed
                const lowerQuery = query.toLowerCase();
                if (lowerQuery.includes('create') || lowerQuery.includes('drop') || 
                    lowerQuery.includes('alter') || lowerQuery.includes('insert') || 
                    lowerQuery.includes('update') || lowerQuery.includes('delete')) {
                    loadTreeView();
                    refreshSchema();
                }
                
            } catch (error) {
                const endTime = performance.now();
                const executionTime = (endTime - startTime).toFixed(2);
                
                resultsDiv.innerHTML = `<div style="background: var(--error); color: white; padding: 15px; border-radius: 8px; margin-top: 10px;">
                    <strong>Error:</strong> ${error.message}
                    <br><small>Execution time: ${executionTime}ms</small>
                </div>`;
                updateStatus(`SQL Error: ${error.message}`);
            }
        }

        // Update properties panel
        function updateProperties(tableName) {
            const propertiesContent = document.getElementById('propertiesContent');
            
            if (!tableName) {
                propertiesContent.innerHTML = `
                    <div class="property-group">
                        <div class="property-label">Name</div>
                        <input type="text" class="property-value" placeholder="No selection" readonly>
                    </div>
                `;
                return;
            }
            
            try {
                const tableInfo = db.exec(`PRAGMA table_info(${tableName})`);
                const rowCount = db.exec(`SELECT COUNT(*) FROM ${tableName}`);
                
                let html = `
                    <div class="property-group">
                        <div class="property-label">Table Name</div>
                        <input type="text" class="property-value" value="${tableName}" readonly>
                    </div>
                    <div class="property-group">
                        <div class="property-label">Row Count</div>
                        <input type="text" class="property-value" value="${rowCount[0]?.values[0]?.[0] || 0}" readonly>
                    </div>
                    <div class="property-group">
                        <div class="property-label">Columns</div>
                        <div style="max-height: 200px; overflow-y: auto;">
                `;
                
                if (tableInfo.length > 0) {
                    tableInfo[0].values.forEach(column => {
                        const [, name, type, notNull, defaultValue, primaryKey] = column;
                        html += `
                            <div style="padding: 8px; background: var(--bg-tertiary); margin: 4px 0; border-radius: 4px; font-size: 12px;">
                                <strong>${name}</strong> <span style="color: var(--text-secondary);">${type}</span>
                                ${primaryKey ? '<span style="color: var(--warning);">PK</span>' : ''}
                                ${notNull ? '<span style="color: var(--error);">NOT NULL</span>' : ''}
                            </div>
                        `;
                    });
                }
                
                html += `
                        </div>
                    </div>
                    <div class="property-group">
                        <div class="property-label">Actions</div>
                        <button class="btn" onclick="exportTable('${tableName}')" style="width: 100%; margin-bottom: 5px;">📤 Export Table</button>
                        <button class="btn" onclick="dropTable('${tableName}')" style="width: 100%; background: var(--error);">🗑️ Drop Table</button>
                    </div>
                `;
                
                propertiesContent.innerHTML = html;
            } catch (error) {
                propertiesContent.innerHTML = `<div style="color: var(--error);">Error loading properties: ${error.message}</div>`;
            }
        }

        // File handling functions
        function openImportModal() {
            document.getElementById('importModal').classList.add('active');
        }

        function closeImportModal() {
            document.getElementById('importModal').classList.remove('active');
        }

        function handleFileSelect(files) {
            if (files.length === 0) return;
            
            const file = files[0];
            const extension = file.name.split('.').pop().toLowerCase();
            
            const reader = new FileReader();
            
            reader.onload = function(e) {
                try {
                    switch (extension) {
                        case 'db':
                        case 'sqlite':
                        case 'sqlite3':
                            loadSQLiteFile(e.target.result);
                            break;
                        case 'sql':
                            loadSQLFile(e.target.result, file.name);
                            break;
                        case 'csv':
                            loadCSVFile(e.target.result, file.name);
                            break;
                        case 'json':
                            loadJSONFile(e.target.result, file.name);
                            break;
                        default:
                            throw new Error('Unsupported file format');
                    }
                    closeImportModal();
                } catch (error) {
                    updateStatus(`Import error: ${error.message}`);
                    alert(`Import failed: ${error.message}`);
                }
            };
            
            if (extension === 'db' || extension === 'sqlite' || extension === 'sqlite3') {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsText(file);
            }
        }

        // Load SQLite file
        function loadSQLiteFile(arrayBuffer) {
            try {
                const SQL = window.SQL;
                const uInt8Array = new Uint8Array(arrayBuffer);
                db = new SQL.Database(uInt8Array);
                loadTreeView();
                updateStatus('SQLite database loaded successfully');
            } catch (error) {
                throw new Error(`Failed to load SQLite file: ${error.message}`);
            }
        }

        // Load SQL file (DDL/DML scripts)
        function loadSQLFile(sqlText, fileName) {
            try {
                // Initialize empty database if not exists
                if (!db) {
                    const SQL = window.SQL;
                    db = new SQL.Database();
                }
                
                // Clean up SQL text
                const cleanedSQL = sqlText
                    .replace(/--.*$/gm, '') // Remove line comments
                    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
                    .replace(/\s+/g, ' ') // Normalize whitespace
                    .trim();
                
                if (!cleanedSQL) {
                    throw new Error('SQL file appears to be empty or contains only comments');
                }
                
                // Split SQL statements by semicolon
                const statements = cleanedSQL.split(';').filter(stmt => stmt.trim());
                
                let executedStatements = 0;
                let errors = [];
                
                statements.forEach((statement, index) => {
                    const trimmedStatement = statement.trim();
                    if (trimmedStatement) {
                        try {
                            db.run(trimmedStatement);
                            executedStatements++;
                        } catch (error) {
                            errors.push(`Statement ${index + 1}: ${error.message}`);
                        }
                    }
                });
                
                if (errors.length > 0 && executedStatements === 0) {
                    throw new Error(`Failed to execute SQL statements:\n${errors.slice(0, 3).join('\n')}`);
                }
                
                loadTreeView();
                refreshSchema();
                
                const statusMessage = `SQL file "${fileName}" loaded: ${executedStatements} statements executed successfully`;
                if (errors.length > 0) {
                    updateStatus(`${statusMessage} (${errors.length} errors - check console)`);
                    console.warn('SQL execution errors:', errors);
                } else {
                    updateStatus(statusMessage);
                }
                
            } catch (error) {
                throw new Error(`Failed to load SQL file: ${error.message}`);
            }
        }

        // Load CSV file
        function loadCSVFile(csvText, fileName) {
            try {
                const lines = csvText.trim().split('\n');
                if (lines.length < 2) throw new Error('CSV must have at least a header and one data row');
                
                const tableName = fileName.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, '_');
                const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
                
                // Create table
                const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (
                    ${headers.map(header => `${header} TEXT`).join(', ')}
                )`;
                
                db.run(createTableSQL);
                
                // Insert data
                const insertSQL = `INSERT INTO ${tableName} (${headers.join(', ')}) VALUES (${headers.map(() => '?').join(', ')})`;
                
                for (let i = 1; i < lines.length; i++) {
                    const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
                    db.run(insertSQL, values);
                }
                
                loadTreeView();
                updateStatus(`CSV imported as table: ${tableName} (${lines.length - 1} rows)`);
            } catch (error) {
                throw new Error(`Failed to load CSV: ${error.message}`);
            }
        }

        // Load JSON file
        function loadJSONFile(jsonText, fileName) {
            try {
                const data = JSON.parse(jsonText);
                const tableName = fileName.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_]/g, '_');
                
                if (!Array.isArray(data)) throw new Error('JSON must contain an array of objects');
                if (data.length === 0) throw new Error('JSON array cannot be empty');
                
                // Get column names from first object
                const columns = Object.keys(data[0]);
                
                // Create table
                const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (
                    ${columns.map(col => `${col} TEXT`).join(', ')}
                )`;
                
                db.run(createTableSQL);
                
                // Insert data
                const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
                
                data.forEach(row => {
                    const values = columns.map(col => row[col] !== undefined ? String(row[col]) : null);
                    db.run(insertSQL, values);
                });
                
                loadTreeView();
                updateStatus(`JSON imported as table: ${tableName} (${data.length} rows)`);
            } catch (error) {
                throw new Error(`Failed to load JSON: ${error.message}`);
            }
        }

        // Export functions
        function exportData() {
            if (!db) {
                alert('No database to export');
                return;
            }
            
            const format = prompt('Export format (db/sql/csv/json):', 'db');
            if (!format) return;
            
            try {
                switch (format.toLowerCase()) {
                    case 'db':
                    case 'sqlite':
                        exportSQLite();
                        break;
                    case 'sql':
                        exportSQL();
                        break;
                    case 'csv':
                        exportAllTablesAsCSV();
                        break;
                    case 'json':
                        exportAllTablesAsJSON();
                        break;
                    default:
                        alert('Unsupported format');
                }
            } catch (error) {
                alert(`Export failed: ${error.message}`);
            }
        }

        function exportSQLite() {
            const data = db.export();
            const blob = new Blob([data], { type: 'application/x-sqlite3' });
            downloadBlob(blob, 'database.db');
            updateStatus('Database exported as SQLite file');
        }

        function exportSQL() {
            try {
                let sqlScript = '-- Database export as SQL script\n';
                sqlScript += '-- Generated on: ' + new Date().toISOString() + '\n\n';
                
                // Get all tables
                const tablesResult = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                if (tablesResult.length === 0) {
                    alert('No tables to export');
                    return;
                }
                
                const tableNames = tablesResult[0].values.map(row => row[0]);
                
                tableNames.forEach(tableName => {
                    sqlScript += `-- Table: ${tableName}\n`;
                    sqlScript += `DROP TABLE IF EXISTS ${tableName};\n`;
                    
                    // Get CREATE statement
                    const createResult = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
                    if (createResult.length > 0) {
                        sqlScript += createResult[0].values[0][0] + ';\n\n';
                    }
                    
                    // Get data
                    const dataResult = db.exec(`SELECT * FROM ${tableName}`);
                    if (dataResult.length > 0) {
                        const columns = dataResult[0].columns;
                        const values = dataResult[0].values;
                        
                        if (values.length > 0) {
                            sqlScript += `-- Data for table: ${tableName}\n`;
                            values.forEach(row => {
                                const formattedValues = row.map(value => {
                                    if (value === null) return 'NULL';
                                    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
                                    return value;
                                }).join(', ');
                                
                                sqlScript += `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${formattedValues});\n`;
                            });
                            sqlScript += '\n';
                        }
                    }
                });
                
                const blob = new Blob([sqlScript], { type: 'text/sql' });
                downloadBlob(blob, 'database.sql');
                updateStatus('Database exported as SQL script');
                
            } catch (error) {
                throw new Error(`Failed to export SQL: ${error.message}`);
            }
        }

        function exportTable(tableName) {
            const format = prompt('Export format (sql/csv/json):', 'csv');
            if (!format) return;
            
            try {
                const result = db.exec(`SELECT * FROM ${tableName}`);
                if (result.length === 0) {
                    alert('No data to export');
                    return;
                }
                
                switch (format.toLowerCase()) {
                    case 'sql':
                        exportTableAsSQL(tableName, result[0]);
                        break;
                    case 'csv':
                        exportTableAsCSV(tableName, result[0]);
                        break;
                    case 'json':
                        exportTableAsJSON(tableName, result[0]);
                        break;
                    default:
                        alert('Unsupported format');
                }
            } catch (error) {
                alert(`Export failed: ${error.message}`);
            }
        }

        function exportTableAsSQL(tableName, result) {
            try {
                let sqlScript = `-- Table export: ${tableName}\n`;
                sqlScript += `-- Generated on: ${new Date().toISOString()}\n\n`;
                
                // Get CREATE statement
                const createResult = db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`);
                if (createResult.length > 0) {
                    sqlScript += `DROP TABLE IF EXISTS ${tableName};\n`;
                    sqlScript += createResult[0].values[0][0] + ';\n\n';
                }
                
                // Add data
                if (result.values.length > 0) {
                    sqlScript += `-- Data for table: ${tableName}\n`;
                    result.values.forEach(row => {
                        const formattedValues = row.map(value => {
                            if (value === null) return 'NULL';
                            if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
                            return value;
                        }).join(', ');
                        
                        sqlScript += `INSERT INTO ${tableName} (${result.columns.join(', ')}) VALUES (${formattedValues});\n`;
                    });
                }
                
                const blob = new Blob([sqlScript], { type: 'text/sql' });
                downloadBlob(blob, `${tableName}.sql`);
                updateStatus(`Table ${tableName} exported as SQL script`);
                
            } catch (error) {
                throw new Error(`Failed to export table as SQL: ${error.message}`);
            }
        }

        function exportTableAsCSV(tableName, result) {
            let csv = result.columns.join(',') + '\n';
            result.values.forEach(row => {
                csv += row.map(cell => `"${cell || ''}"`).join(',') + '\n';
            });
            
            const blob = new Blob([csv], { type: 'text/csv' });
            downloadBlob(blob, `${tableName}.csv`);
            updateStatus(`Table ${tableName} exported as CSV`);
        }

        function exportTableAsJSON(tableName, result) {
            const data = result.values.map(row => {
                const obj = {};
                result.columns.forEach((col, index) => {
                    obj[col] = row[index];
                });
                return obj;
            });
            
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            downloadBlob(blob, `${tableName}.json`);
            updateStatus(`Table ${tableName} exported as JSON`);
        }

        function exportAllTablesAsCSV() {
            const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
            if (tables.length === 0 || tables[0].values.length === 0) {
                alert('No tables to export');
                return;
            }
            
            tables[0].values.forEach(([tableName]) => {
                const result = db.exec(`SELECT * FROM ${tableName}`);
                if (result.length > 0) {
                    exportTableAsCSV(tableName, result[0]);
                }
            });
        }

        function exportAllTablesAsJSON() {
            const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
            if (tables.length === 0 || tables[0].values.length === 0) {
                alert('No tables to export');
                return;
            }
            
            const allData = {};
            
            tables[0].values.forEach(([tableName]) => {
                const result = db.exec(`SELECT * FROM ${tableName}`);
                if (result.length > 0) {
                    allData[tableName] = result[0].values.map(row => {
                        const obj = {};
                        result[0].columns.forEach((col, index) => {
                            obj[col] = row[index];
                        });
                        return obj;
                    });
                }
            });
            
            const json = JSON.stringify(allData, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            downloadBlob(blob, 'database.json');
            updateStatus('All tables exported as JSON');
        }

        // Utility functions
        function downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function updateStatus(message) {
            document.getElementById('statusBar').textContent = message;
        }

        function filterTables(searchTerm) {
            const treeItems = document.querySelectorAll('.tree-item');
            treeItems.forEach(item => {
                const text = item.textContent.toLowerCase();
                if (text.includes(searchTerm.toLowerCase())) {
                    item.style.display = 'flex';
                } else {
                    item.style.display = 'none';
                }
            });
        }

        function selectDatabase() {
            currentTable = null;
            document.querySelectorAll('.tree-item').forEach(item => item.classList.remove('active'));
            event.target.classList.add('active');
            
            const container = document.querySelector('#table-view .table-container');
            container.innerHTML = '<div class="loading"><p>Select a table to view data</p></div>';
            
            updateProperties(null);
            refreshSchema();
        }

        function createNewTable() {
            const tableName = prompt('Enter table name:');
            if (!tableName) return;
            
            const columns = prompt('Enter columns (format: name TYPE, name TYPE, ...):', 'id INTEGER PRIMARY KEY, name TEXT');
            if (!columns) return;
            
            try {
                db.run(`CREATE TABLE ${tableName} (${columns})`);
                loadTreeView();
                updateStatus(`Created table: ${tableName}`);
            } catch (error) {
                alert(`Failed to create table: ${error.message}`);
            }
        }

        function dropTable(tableName) {
            if (confirm(`Are you sure you want to drop table "${tableName}"? This cannot be undone.`)) {
                try {
                    db.run(`DROP TABLE ${tableName}`);
                    loadTreeView();
                    selectDatabase();
                    updateStatus(`Dropped table: ${tableName}`);
                } catch (error) {
                    alert(`Failed to drop table: ${error.message}`);
                }
            }
        }

        // Event listeners
        document.addEventListener('DOMContentLoaded', function() {
            initApp();
            
            // File drop functionality
            const dropZone = document.querySelector('.file-drop-zone');
            
            dropZone.addEventListener('dragover', function(e) {
                e.preventDefault();
                this.classList.add('dragover');
            });
            
            dropZone.addEventListener('dragleave', function(e) {
                e.preventDefault();
                this.classList.remove('dragover');
            });
            
            dropZone.addEventListener('drop', function(e) {
                e.preventDefault();
                this.classList.remove('dragover');
                handleFileSelect(e.dataTransfer.files);
            });
            
            // Window resize - redraw ER diagram connections
            window.addEventListener('resize', function() {
                setTimeout(() => {
                    updateCanvasTransform();
                    drawAllConnectors();
                }, 100);
            });
        });

        // SQL Editor helper functions
        function clearSqlEditor() {
            if (sqlEditor) {
                sqlEditor.setValue('');
            } else {
                document.getElementById('sqlEditor').value = '';
            }
            document.getElementById('sqlResults').innerHTML = '';
            updateStatus('SQL editor cleared');
        }

        function loadSqlTemplate() {
            document.getElementById('templateModal').classList.add('active');
        }

        function closeTemplateModal() {
            document.getElementById('templateModal').classList.remove('active');
        }

        function insertTemplate(templateType) {
            const templates = {
                'create-table': `-- Create a new table
CREATE TABLE table_name (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`,
                'drop-table': `-- Drop a table (be careful!)
DROP TABLE IF EXISTS table_name;`,
                'insert': `-- Insert new data
INSERT INTO table_name (column1, column2, column3) 
VALUES 
    ('value1', 'value2', 'value3'),
    ('value4', 'value5', 'value6');`,
                'select': `-- Select data from table
SELECT column1, column2, column3
FROM table_name
WHERE condition = 'value'
ORDER BY column1 ASC
LIMIT 10;`,
                'update': `-- Update existing data
UPDATE table_name 
SET column1 = 'new_value',
    column2 = 'another_value'
WHERE condition = 'specific_value';`,
                'delete': `-- Delete data from table
DELETE FROM table_name 
WHERE condition = 'value';`,
                'alter-table': `-- Modify table structure
ALTER TABLE table_name 
ADD COLUMN new_column TEXT;

-- Or rename column
-- ALTER TABLE table_name 
-- RENAME COLUMN old_name TO new_name;`,
                'create-index': `-- Create an index for better performance
CREATE INDEX idx_table_column 
ON table_name(column_name);

-- Create unique index
-- CREATE UNIQUE INDEX idx_unique_column 
-- ON table_name(column_name);`,
                'join': `-- Join multiple tables
SELECT t1.column1, t1.column2, t2.column3
FROM table1 t1
INNER JOIN table2 t2 ON t1.id = t2.foreign_id
WHERE t1.condition = 'value';

-- Different join types:
-- LEFT JOIN, RIGHT JOIN, FULL OUTER JOIN`,
                'view': `-- Create a view (virtual table)
CREATE VIEW view_name AS
SELECT column1, column2, COUNT(*) as count
FROM table_name
WHERE condition = 'value'
GROUP BY column1, column2;`,
                'trigger': `-- Create a trigger
CREATE TRIGGER trigger_name
AFTER INSERT ON table_name
FOR EACH ROW
BEGIN
    UPDATE another_table 
    SET updated_at = CURRENT_TIMESTAMP 
    WHERE id = NEW.foreign_id;
END;`,
                'aggregate': `-- Aggregate functions
SELECT 
    COUNT(*) as total_rows,
    COUNT(DISTINCT column1) as unique_values,
    SUM(numeric_column) as total_sum,
    AVG(numeric_column) as average,
    MIN(numeric_column) as minimum,
    MAX(numeric_column) as maximum
FROM table_name
GROUP BY category_column
HAVING COUNT(*) > 5;`
            };

            const template = templates[templateType];
            if (!template) return;

            if (sqlEditor) {
                const currentValue = sqlEditor.getValue();
                const newValue = currentValue ? currentValue + '\n\n' + template : template;
                sqlEditor.setValue(newValue);
                sqlEditor.focus();
            } else {
                const textarea = document.getElementById('sqlEditor');
                const currentValue = textarea.value;
                const newValue = currentValue ? currentValue + '\n\n' + template : template;
                textarea.value = newValue;
                textarea.focus();
            }

            closeTemplateModal();
            updateStatus(`Template inserted: ${templateType.replace('-', ' ').toUpperCase()}`);
        }

        function exportSqlQuery() {
            let query;
            if (sqlEditor) {
                query = sqlEditor.getValue();
            } else {
                query = document.getElementById('sqlEditor').value;
            }
            
            if (!query.trim()) {
                alert('No query to export');
                return;
            }
            
            const blob = new Blob([query], { type: 'text/sql' });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            downloadBlob(blob, `query_${timestamp}.sql`);
            updateStatus('SQL query exported');
        }

        // Mobile responsive behavior
        function toggleSidebar() {
            const sidebar = document.querySelector('.sidebar');
            sidebar.classList.toggle('mobile-visible');
        }

        // Add mobile styles for sidebar toggle
        if (window.innerWidth <= 768) {
            const style = document.createElement('style');
            style.textContent = `
                .sidebar {
                    position: fixed;
                    left: -300px;
                    top: 60px;
                    width: 300px;
                    height: calc(100vh - 60px);
                    z-index: 999;
                    transition: left 0.3s;
                }
                .sidebar.mobile-visible {
                    left: 0;
                }
                .mobile-menu-btn {
                    display: block !important;
                }
                @media (min-width: 769px) {
                    .mobile-menu-btn {
                        display: none !important;
                    }
                }
            `;
            document.head.appendChild(style);
            
            // Add menu button to header
            const headerActions = document.querySelector('.header-actions');
            const menuBtn = document.createElement('button');
            menuBtn.className = 'btn mobile-menu-btn';
            menuBtn.innerHTML = '☰';
            menuBtn.onclick = toggleSidebar;
            headerActions.insertBefore(menuBtn, headerActions.firstChild);
        }