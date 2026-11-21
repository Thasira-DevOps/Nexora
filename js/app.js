// ---------- Database (IndexedDB, stored only on this device) ----------
const DB_NAME = "nexora";
const DB_VERSION = 2;
const STORE_COOKIES = "cookies";
const STORE_NOTES = "notes";

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_COOKIES)) {
                db.createObjectStore(STORE_COOKIES, {keyPath: "id", autoIncrement: true});
            }
            if (!db.objectStoreNames.contains(STORE_NOTES)) {
                db.createObjectStore(STORE_NOTES, { keyPath: "id", autoIncrement: true });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function addCookie(text) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_COOKIES, "readwrite");
        tx.objectStore(STORE_COOKIES).add({text: text, createdAt: Date.now()});
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getAllCookies() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_COOKIES, "readonly");
        const request = tx.objectStore(STORE_COOKIES).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ---------- Cookie Jar UI ----------
const cookieInput = document.getElementById("cookie-input");
const cookieDisplay = document.getElementById("cookie-display");

document.getElementById("add-cookie").addEventListener("click", async () => {
    const text = cookieInput.value.trim();
    if (text === "") {
        cookieDisplay.textContent = "Write something first.";
        return;
    }
    await addCookie(text);
    cookieInput.value = "";
    cookieDisplay.textContent = "Cookie added to your jar! 🍪";
});

document.getElementById("pull-cookie").addEventListener("click", async () => {
    const cookies = await getAllCookies();
    if (cookies.length === 0) {
        cookieDisplay.textContent = "Your jar is empty. Add your first cookie!";
        return;
    }
    const randomIndex = Math.floor(Math.random() * cookies.length);
    cookieDisplay.textContent = cookies[randomIndex].text;
});
// ---------- Notes & Reminders ----------
async function addNote(note) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, "readwrite");
        tx.objectStore(STORE_NOTES).add(note);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getAllNotes() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, "readonly");
        const request = tx.objectStore(STORE_NOTES).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function deleteNote(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NOTES, "readwrite");
        tx.objectStore(STORE_NOTES).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

const noteTitle = document.getElementById("note-title");
const noteBody = document.getElementById("note-body");
const noteDue = document.getElementById("note-due");
const noteList = document.getElementById("note-list");

async function renderNotes() {
    const notes = await getAllNotes();
    const sortKey = (n) => n.due ?? Number.MAX_SAFE_INTEGER;
    notes.sort((a, b) => sortKey(a) - sortKey(b));

    noteList.innerHTML = "";
    for (const note of notes) {
        const li = document.createElement("li");
        const isDue = note.due !== null && note.due <= Date.now();

        let label = (isDue ? "⏰ DUE: " : "") + note.title;
        if (note.due !== null) {
            label += " (" + new Date(note.due).toLocaleString() + ")";
        }
        if (note.body) {
            label += " - " + note.body;
        }
        li.textContent = label + " ";

        const deleteButton = document.createElement("button");
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", async () => {
            await deleteNote(note.id);
            renderNotes();
        });

        li.appendChild(deleteButton);
        noteList.appendChild(li);
    }
}

document.getElementById("add-note").addEventListener("click", async () => {
    const title = noteTitle.value.trim();
    if (title === "") {
        return;
    }
    await addNote({
        title: title,
        body: noteBody.value.trim(),
        due: noteDue.value ? new Date(noteDue.value).getTime() : null,
        createdAt: Date.now()
    });
    noteTitle.value = "";
    noteBody.value = "";
    noteDue.value = "";
    renderNotes();
});

// Show saved notes on load, and refresh every 30 seconds so due reminders get marked
renderNotes();
setInterval(renderNotes, 30000);
// ---------- Backup: Export / Import ----------
const backupStatus = document.getElementById("backup-status");

async function exportAllData() {
    const data = {
        app: "nexora",
        version: 1,
        exportedAt: new Date().toISOString(),
        cookies: await getAllCookies(),
        notes: await getAllNotes()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "nexora-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    link.click();
    URL.revokeObjectURL(url);

    backupStatus.textContent = "Backup file downloaded. Keep it somewhere safe.";
}

// Replaces everything in a store with the given items (ids are kept)
async function replaceStore(storeName, items) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        store.clear();
        for (const item of items) {
            store.put(item);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function importAllData(file) {
    try {
        const data = JSON.parse(await file.text());

        const isValid = data.app === "nexora" &&
            Array.isArray(data.cookies) &&
            Array.isArray(data.notes);
        if (!isValid) {
            backupStatus.textContent = "This is not a valid Nexora backup file.";
            return;
        }

        const confirmed = confirm("Importing will replace ALL current data in this app. Continue?");
        if (!confirmed) {
            return;
        }

        await replaceStore(STORE_COOKIES, data.cookies);
        await replaceStore(STORE_NOTES, data.notes);
        await renderNotes();
        backupStatus.textContent = "Import complete: " + data.cookies.length + " cookies and " +
            data.notes.length + " notes restored.";
    } catch (error) {
        backupStatus.textContent = "Import failed. The file may be damaged.";
    }
}

document.getElementById("export-data").addEventListener("click", exportAllData);

document.getElementById("import-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (file) {
        await importAllData(file);
        event.target.value = "";
    }
});

// ---------- PWA: register the service worker ----------
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
}