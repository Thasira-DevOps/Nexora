// ---------- Database (IndexedDB, stored only on this device) ----------
const DB_NAME = "nexora";
const DB_VERSION = 4;
const STORE_COOKIES = "cookies";
const STORE_NOTES = "notes";
const STORE_EVENTS = "events";
const STORE_GOALS = "goals";

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of [STORE_COOKIES, STORE_NOTES, STORE_EVENTS, STORE_GOALS]) {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
                }
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            // Let a newer version of the app upgrade the database
            db.onversionchange = () => db.close();
            resolve(db);
        };

        request.onerror = () => reject(request.error);
        request.onblocked = () => alert("Please close other Nexora tabs or windows, then reload this page.");
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

    if (notes.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No notes yet. Add your first one above.";
        noteList.appendChild(empty);
        return;
    }

    for (const note of notes) {
        const isDue = note.due !== null && note.due <= Date.now();

        const li = document.createElement("li");
        li.className = "note" + (isDue ? " due" : "");

        const text = document.createElement("div");
        text.className = "note-text";

        const title = document.createElement("strong");
        title.textContent = note.title;
        text.appendChild(title);

        if (note.due !== null) {
            const when = document.createElement("small");
            when.textContent = (isDue ? "Due now: " : "Due: ") + new Date(note.due).toLocaleString();
            text.appendChild(when);
        }

        if (note.body) {
            const body = document.createElement("p");
            body.textContent = note.body;
            text.appendChild(body);
        }

        const deleteButton = document.createElement("button");
        deleteButton.className = "ghost";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", async () => {
            await deleteNote(note.id);
            renderNotes();
        });

        li.append(text, deleteButton);
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
    try {
        const data = {
            app: "nexora",
            version: 2,
            exportedAt: new Date().toISOString(),
            cookies: await getAllCookies(),
            notes: await getAllNotes(),
            events: await dbGetAll(STORE_EVENTS),
            goals: await dbGetAll(STORE_GOALS)
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "nexora-backup-" + new Date().toISOString().slice(0, 10) + ".json";
        link.click();
        URL.revokeObjectURL(url);

        backupStatus.textContent = "Backup file downloaded. Keep it somewhere safe.";
    } catch (error) {
        backupStatus.textContent = "Export failed: " + error.message;
    }
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

        // Older backups (version 1) have no events or goals
        const events = Array.isArray(data.events) ? data.events : [];
        const goals = Array.isArray(data.goals) ? data.goals : [];

        await replaceStore(STORE_COOKIES, data.cookies);
        await replaceStore(STORE_NOTES, data.notes);
        await replaceStore(STORE_EVENTS, events);
        await replaceStore(STORE_GOALS, goals);
        await renderNotes();
        await renderCalendar();
        await renderGoals();
        backupStatus.textContent = "Import complete: " + data.cookies.length + " cookies, " +
            data.notes.length + " notes, " + events.length + " events and " +
            goals.length + " goals restored.";
    } catch (error) {
        backupStatus.textContent = "Import failed. The file may be damaged.";
    }
}

// ---------- PWA: register the service worker ----------
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
}

// ---------- Tabs ----------
const tabButtons = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

function showTab(name) {
    tabButtons.forEach((button) => {
        const isActive = button.dataset.tab === name;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-selected", String(isActive));
    });
    panels.forEach((panel) => {
        panel.hidden = panel.id !== name;
    });
    if (name === "calendar") renderCalendar();
    if (name === "goals") renderGoals();
}

// ---------- Generic database helpers ----------
async function dbGetAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Adds a new item, or updates it if it already has an id
async function dbPut(storeName, item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function dbDelete(storeName, id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------- Calendar ----------
const calendarGrid = document.getElementById("calendar-grid");
const calendarTitle = document.getElementById("calendar-title");
const dayHeading = document.getElementById("day-heading");
const dayList = document.getElementById("day-list");
const eventTitle = document.getElementById("event-title");
const eventDate = document.getElementById("event-date");
const eventTime = document.getElementById("event-time");
const eventRepeat = document.getElementById("event-repeat");

let viewYear = new Date().getFullYear();
let viewMonth = new Date().getMonth();
let selectedDate = toDateString(new Date());

// Dates are stored as "YYYY-MM-DD" in local time
function toDateString(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day;
}

function parseDate(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(year, month - 1, day);
}

// Weekly events repeat on the same weekday from their start date onwards
function occursOn(event, dateString) {
    if (event.date === dateString) return true;
    if (event.repeat === "weekly" && dateString > event.date) {
        return parseDate(event.date).getDay() === parseDate(dateString).getDay();
    }
    return false;
}

function noteIsOn(note, dateString) {
    return note.due !== null && toDateString(new Date(note.due)) === dateString;
}

async function renderCalendar() {
    const events = await dbGetAll(STORE_EVENTS);
    const notes = await getAllNotes();

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    calendarTitle.textContent = firstOfMonth.toLocaleString("en-US", { month: "long", year: "numeric" });

    calendarGrid.innerHTML = "";

    for (const name of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
        const cell = document.createElement("div");
        cell.className = "dow";
        cell.textContent = name;
        calendarGrid.appendChild(cell);
    }

    for (let i = 0; i < firstOfMonth.getDay(); i++) {
        calendarGrid.appendChild(document.createElement("div"));
    }

    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const todayString = toDateString(new Date());

    for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(viewYear, viewMonth, day);
        const dateString = toDateString(date);

        const button = document.createElement("button");
        button.className = "day";
        button.textContent = day;
        button.setAttribute("aria-label", date.toDateString());
        if (dateString === todayString) button.classList.add("today");
        if (dateString === selectedDate) button.classList.add("selected");

        const hasItems = events.some((e) => occursOn(e, dateString)) ||
            notes.some((n) => noteIsOn(n, dateString));
        if (hasItems) button.classList.add("has-items");

        button.addEventListener("click", () => {
            selectedDate = dateString;
            eventDate.value = dateString;
            renderCalendar();
        });
        calendarGrid.appendChild(button);
    }

    renderDayList(events, notes);
}

function renderDayList(events, notes) {
    dayHeading.textContent = parseDate(selectedDate).toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric"
    });
    dayList.innerHTML = "";

    const dayEvents = events
        .filter((e) => occursOn(e, selectedDate))
        .sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const dayNotes = notes.filter((n) => noteIsOn(n, selectedDate));

    if (dayEvents.length === 0 && dayNotes.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "Nothing planned for this day.";
        dayList.appendChild(empty);
        return;
    }

    for (const event of dayEvents) {
        const li = document.createElement("li");
        li.className = "note event";

        const text = document.createElement("div");
        text.className = "note-text";
        const title = document.createElement("strong");
        title.textContent = event.title;
        const detail = document.createElement("small");
        detail.textContent = (event.time || "All day") + (event.repeat === "weekly" ? " (repeats weekly)" : "");
        text.append(title, detail);

        const deleteButton = document.createElement("button");
        deleteButton.className = "ghost";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", async () => {
            const message = event.repeat === "weekly"
                ? "Delete this event and all its weekly repeats?"
                : "Delete this event?";
            if (!confirm(message)) return;
            await dbDelete(STORE_EVENTS, event.id);
            renderCalendar();
        });

        li.append(text, deleteButton);
        dayList.appendChild(li);
    }

    for (const note of dayNotes) {
        const li = document.createElement("li");
        li.className = "note";

        const text = document.createElement("div");
        text.className = "note-text";
        const title = document.createElement("strong");
        title.textContent = note.title;
        const detail = document.createElement("small");
        detail.textContent = "Reminder at " +
            new Date(note.due).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        text.append(title, detail);

        li.appendChild(text);
        dayList.appendChild(li);
    }
}

document.getElementById("prev-month").addEventListener("click", () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
});

document.getElementById("next-month").addEventListener("click", () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
});

document.getElementById("today-button").addEventListener("click", () => {
    const today = new Date();
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    selectedDate = toDateString(today);
    eventDate.value = selectedDate;
    renderCalendar();
});

document.getElementById("add-event").addEventListener("click", async () => {
    const title = eventTitle.value.trim();
    if (title === "" || eventDate.value === "") return;

    await dbPut(STORE_EVENTS, {
        title: title,
        date: eventDate.value,
        time: eventTime.value,
        repeat: eventRepeat.checked ? "weekly" : "none",
        createdAt: Date.now()
    });

    eventTitle.value = "";
    eventTime.value = "";
    eventRepeat.checked = false;

    selectedDate = eventDate.value;
    const picked = parseDate(selectedDate);
    viewYear = picked.getFullYear();
    viewMonth = picked.getMonth();
    renderCalendar();
});

// ---------- Goal Map ----------
const goalTitle = document.getElementById("goal-title");
const goalSteps = document.getElementById("goal-steps");
const goalList = document.getElementById("goal-list");

async function renderGoals() {
    const goals = await dbGetAll(STORE_GOALS);
    goalList.innerHTML = "";

    if (goals.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No goals yet. Add one above and break it into steps.";
        goalList.appendChild(empty);
        return;
    }

    for (const goal of goals) {
        const doneCount = goal.steps.filter((s) => s.done).length;
        const percent = goal.steps.length === 0 ? 0 : Math.round((doneCount / goal.steps.length) * 100);
        const nextIndex = goal.steps.findIndex((s) => !s.done);

        const card = document.createElement("li");
        card.className = "goal";

        const header = document.createElement("div");
        header.className = "goal-header";
        const title = document.createElement("strong");
        title.textContent = goal.title;
        const deleteButton = document.createElement("button");
        deleteButton.className = "ghost";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", async () => {
            if (!confirm("Delete this goal?")) return;
            await dbDelete(STORE_GOALS, goal.id);
            renderGoals();
        });
        header.append(title, deleteButton);

        const progress = document.createElement("div");
        progress.className = "progress";
        const bar = document.createElement("div");
        bar.className = "progress-bar";
        bar.style.width = percent + "%";
        progress.appendChild(bar);

        const caption = document.createElement("small");
        caption.textContent = doneCount + " of " + goal.steps.length + " steps done (" + percent + "%)";

        const route = document.createElement("ol");
        route.className = "route";

        goal.steps.forEach((step, index) => {
            const stop = document.createElement("li");
            stop.className = "stop" + (step.done ? " done" : "") + (index === nextIndex ? " next" : "");

            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = step.done;
            checkbox.addEventListener("change", async () => {
                goal.steps[index].done = checkbox.checked;
                await dbPut(STORE_GOALS, goal);
                renderGoals();
            });
            const text = document.createElement("span");
            text.textContent = step.text;

            label.append(checkbox, text);
            stop.appendChild(label);
            route.appendChild(stop);
        });

        card.append(header, progress, caption, route);
        goalList.appendChild(card);
    }
}

document.getElementById("add-goal").addEventListener("click", async () => {
    const title = goalTitle.value.trim();
    if (title === "") return;

    const steps = goalSteps.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((text) => ({ text: text, done: false }));

    await dbPut(STORE_GOALS, { title: title, steps: steps, createdAt: Date.now() });

    goalTitle.value = "";
    goalSteps.value = "";
    renderGoals();
});

// Initial render
eventDate.value = selectedDate;
renderCalendar();
renderGoals();

tabButtons.forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
});