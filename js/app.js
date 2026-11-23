// ================= Nexora =================

// ---------- Database (IndexedDB, stored only on this device) ----------
const DB_NAME = "nexora";
const DB_VERSION = 6;
const STORE_COOKIES = "cookies";
const STORE_NOTES = "notes";
const STORE_EVENTS = "events";
const STORE_GOALS = "goals";
const STORE_CHECKINS = "checkins";
const STORE_SESSIONS = "sessions";
const ALL_STORES = [STORE_COOKIES, STORE_NOTES, STORE_EVENTS, STORE_GOALS, STORE_CHECKINS, STORE_SESSIONS];

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            for (const name of ALL_STORES) {
                if (!db.objectStoreNames.contains(name)) {
                    // Check-ins are keyed by their date (one per day); everything else gets an auto id
                    if (name === STORE_CHECKINS) {
                        db.createObjectStore(name, { keyPath: "date" });
                    } else {
                        db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
                    }
                }
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            // Allow a newer version of the app to upgrade the database
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            resolve(db);
        };

        request.onerror = () => {
            dbPromise = null;
            reject(request.error);
        };

        request.onblocked = () => {
            alert("Please close other Nexora tabs or windows, then reload this page.");
        };
    });

    return dbPromise;
}

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

// Replaces everything in a store with the given items (ids are kept)
async function dbReplaceAll(storeName, items) {
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

// Wraps a handler so that any error is shown instead of failing silently
function safe(handler) {
    return async (...args) => {
        try {
            await handler(...args);
        } catch (error) {
            console.error(error);
            alert("Something went wrong: " + error.message);
        }
    };
}

// ---------- Date helpers ----------
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

// ---------- Notifications (these work while the app is open) ----------
const FIRED_KEY = "nexora-fired";

function notificationsSupported() {
    return "Notification" in window;
}

async function notify(title, body) {
    if (!notificationsSupported() || Notification.permission !== "granted") return;

    try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
            await registration.showNotification(title, {
                body: body,
                icon: "icons/icon-192.png",
                badge: "icons/icon-192.png"
            });
            return;
        }
    } catch (error) {
        // Fall back to a plain notification below
    }

    try {
        new Notification(title, { body: body, icon: "icons/icon-192.png" });
    } catch (error) {
        console.error(error);
    }
}

// ---------- Calendar files (.ics): reminders from your phone's own calendar app ----------
function icsEscape(text) {
    return String(text || "")
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r?\n/g, "\\n");
}

function icsStamp(date) {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function buildIcs(item) {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Nexora//Planner//EN",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        "UID:" + item.uid,
        "DTSTAMP:" + icsStamp(new Date()),
        "SUMMARY:" + icsEscape(item.title)
    ];

    if (item.allDayDate) {
        lines.push("DTSTART;VALUE=DATE:" + item.allDayDate.replace(/-/g, ""));
    } else {
        const end = new Date(item.start.getTime() + item.minutes * 60000);
        lines.push("DTSTART:" + icsStamp(item.start), "DTEND:" + icsStamp(end));
    }

    if (item.weekly) lines.push("RRULE:FREQ=WEEKLY");
    if (item.description) lines.push("DESCRIPTION:" + icsEscape(item.description));

    if (!item.allDayDate) {
        const trigger = item.alarmMinutes === 0 ? "PT0S" : "-PT" + item.alarmMinutes + "M";
        lines.push(
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "DESCRIPTION:" + icsEscape(item.title),
            "TRIGGER:" + trigger,
            "END:VALARM"
        );
    }

    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
}

function downloadIcs(filename, item) {
    const blob = new Blob([buildIcs(item)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Cookie Jar ----------
const cookieInput = document.getElementById("cookie-input");
const cookieDisplay = document.getElementById("cookie-display");
const jar = document.getElementById("jar");
const jarCount = document.getElementById("jar-count");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let lastCookieId = null;
let pulling = false;

async function renderJar() {
    const cookies = await dbGetAll(STORE_COOKIES);

    jar.innerHTML = "";
    // The jar fills up as you add cookies (up to 12 are drawn)
    for (let i = 0; i < Math.min(cookies.length, 12); i++) {
        const cookie = document.createElement("span");
        cookie.className = "cookie";
        cookie.textContent = "🍪";
        jar.appendChild(cookie);
    }

    if (cookies.length === 0) {
        jarCount.textContent = "Your jar is empty";
    } else if (cookies.length === 1) {
        jarCount.textContent = "1 cookie in your jar";
    } else {
        jarCount.textContent = cookies.length + " cookies in your jar";
    }
}

function showCookieText(text, animate) {
    cookieDisplay.textContent = text;
    cookieDisplay.classList.remove("reveal");
    if (animate) {
        void cookieDisplay.offsetWidth; // restart the animation
        cookieDisplay.classList.add("reveal");
    }
}

document.getElementById("add-cookie").addEventListener("click", safe(async () => {
    const text = cookieInput.value.trim();
    if (text === "") {
        showCookieText("Write something first.", false);
        return;
    }
    await dbPut(STORE_COOKIES, { text: text, createdAt: Date.now() });
    cookieInput.value = "";
    showCookieText("Cookie added to your jar! 🍪", false);
    await renderJar();
}));

document.getElementById("pull-cookie").addEventListener("click", safe(async () => {
    if (pulling) return;

    const cookies = await dbGetAll(STORE_COOKIES);
    if (cookies.length === 0) {
        showCookieText("Your jar is empty. Add your first cookie!", false);
        return;
    }

    // Avoid showing the same cookie twice in a row when there are others
    const pool = cookies.length > 1 ? cookies.filter((c) => c.id !== lastCookieId) : cookies;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    lastCookieId = picked.id;

    pulling = true;
    try {
        showCookieText("", false);
        jar.classList.remove("shake");
        void jar.offsetWidth; // restart the animation
        jar.classList.add("shake");
        await new Promise((resolve) => setTimeout(resolve, reducedMotion.matches ? 0 : 600));
        jar.classList.remove("shake");
        showCookieText(picked.text, true);
    } finally {
        pulling = false;
    }
}));

// ---------- Notes & Reminders ----------
const noteTitle = document.getElementById("note-title");
const noteBody = document.getElementById("note-body");
const noteDue = document.getElementById("note-due");
const noteList = document.getElementById("note-list");

async function renderNotes() {
    const notes = await dbGetAll(STORE_NOTES);
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

        const actions = document.createElement("div");
        actions.className = "row-actions";

        if (note.due !== null) {
            const phoneButton = document.createElement("button");
            phoneButton.className = "ghost";
            phoneButton.textContent = "Add to phone";
            phoneButton.addEventListener("click", safe(async () => {
                downloadIcs("nexora-reminder.ics", {
                    uid: "nexora-note-" + note.id + "-" + note.createdAt + "@nexora.local",
                    title: note.title,
                    description: note.body,
                    start: new Date(note.due),
                    minutes: 15,
                    alarmMinutes: 0
                });
            }));
            actions.appendChild(phoneButton);
        }

        const deleteButton = document.createElement("button");
        deleteButton.className = "ghost";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", safe(async () => {
            await dbDelete(STORE_NOTES, note.id);
            await renderNotes();
        }));
        actions.appendChild(deleteButton);

        li.append(text, actions);
        noteList.appendChild(li);
    }
}

document.getElementById("add-note").addEventListener("click", safe(async () => {
    const title = noteTitle.value.trim();
    if (title === "") return;

    await dbPut(STORE_NOTES, {
        title: title,
        body: noteBody.value.trim(),
        due: noteDue.value ? new Date(noteDue.value).getTime() : null,
        createdAt: Date.now()
    });

    noteTitle.value = "";
    noteBody.value = "";
    noteDue.value = "";
    await renderNotes();
}));

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

async function renderCalendar() {
    const events = await dbGetAll(STORE_EVENTS);
    const notes = await dbGetAll(STORE_NOTES);

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

        button.addEventListener("click", safe(async () => {
            selectedDate = dateString;
            eventDate.value = dateString;
            await renderCalendar();
        }));
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

        const actions = document.createElement("div");
        actions.className = "row-actions";

        const phoneButton = document.createElement("button");
        phoneButton.className = "ghost";
        phoneButton.textContent = "Add to phone";
        phoneButton.addEventListener("click", safe(async () => {
            downloadIcs("nexora-event.ics", {
                uid: "nexora-event-" + event.id + "-" + event.createdAt + "@nexora.local",
                title: event.title,
                description: "",
                start: event.time ? new Date(event.date + "T" + event.time) : null,
                allDayDate: event.time ? null : event.date,
                minutes: 60,
                weekly: event.repeat === "weekly",
                alarmMinutes: 10
            });
        }));

        const deleteButton = document.createElement("button");
        deleteButton.className = "ghost";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", safe(async () => {
            const message = event.repeat === "weekly"
                ? "Delete this event and all its weekly repeats?"
                : "Delete this event?";
            if (!confirm(message)) return;
            await dbDelete(STORE_EVENTS, event.id);
            await renderCalendar();
        }));

        actions.append(phoneButton, deleteButton);
        li.append(text, actions);
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

document.getElementById("prev-month").addEventListener("click", safe(async () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    await renderCalendar();
}));

document.getElementById("next-month").addEventListener("click", safe(async () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    await renderCalendar();
}));

document.getElementById("today-button").addEventListener("click", safe(async () => {
    const today = new Date();
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    selectedDate = toDateString(today);
    eventDate.value = selectedDate;
    await renderCalendar();
}));

document.getElementById("add-event").addEventListener("click", safe(async () => {
    const title = eventTitle.value.trim();
    if (title === "" || eventDate.value === "") {
        alert("Please enter a title and pick a date.");
        return;
    }

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
    await renderCalendar();
}));

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
        deleteButton.addEventListener("click", safe(async () => {
            if (!confirm("Delete this goal?")) return;
            await dbDelete(STORE_GOALS, goal.id);
            await renderGoals();
        }));
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
            checkbox.addEventListener("change", safe(async () => {
                goal.steps[index].done = checkbox.checked;
                await dbPut(STORE_GOALS, goal);
                await renderGoals();
            }));
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

document.getElementById("add-goal").addEventListener("click", safe(async () => {
    const title = goalTitle.value.trim();
    if (title === "") {
        alert("Please enter a goal.");
        return;
    }

    const steps = goalSteps.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((text) => ({ text: text, done: false }));

    await dbPut(STORE_GOALS, { title: title, steps: steps, createdAt: Date.now() });

    goalTitle.value = "";
    goalSteps.value = "";
    await renderGoals();
}));

// ---------- Today ----------
const todayHeading = document.getElementById("today-heading");
const todayDate = document.getElementById("today-date");
const todaySchedule = document.getElementById("today-schedule");
const todaySteps = document.getElementById("today-steps");

function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
}

function addEmptyItem(list, message) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = message;
    list.appendChild(empty);
}

async function renderToday() {
    const events = await dbGetAll(STORE_EVENTS);
    const notes = await dbGetAll(STORE_NOTES);
    const goals = await dbGetAll(STORE_GOALS);

    const now = new Date();
    const todayString = toDateString(now);

    todayHeading.textContent = greeting();
    todayDate.textContent = now.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric"
    });

    // Schedule: today's events and reminders, in time order
    const items = [];
    for (const event of events.filter((e) => occursOn(e, todayString))) {
        items.push({
            title: event.title,
            sortKey: event.time || "",
            label: event.time || "All day",
            isEvent: true,
            isDue: false
        });
    }
    for (const note of notes.filter((n) => noteIsOn(n, todayString))) {
        const due = new Date(note.due);
        items.push({
            title: note.title,
            sortKey: String(due.getHours()).padStart(2, "0") + ":" + String(due.getMinutes()).padStart(2, "0"),
            label: "Reminder at " + due.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            isEvent: false,
            isDue: note.due <= Date.now()
        });
    }
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    todaySchedule.innerHTML = "";
    if (items.length === 0) {
        addEmptyItem(todaySchedule, "Nothing scheduled today. Add an event in Calendar.");
    }
    for (const item of items) {
        const li = document.createElement("li");
        li.className = "note" + (item.isEvent ? " event" : "") + (item.isDue ? " due" : "");

        const text = document.createElement("div");
        text.className = "note-text";
        const title = document.createElement("strong");
        title.textContent = item.title;
        const detail = document.createElement("small");
        detail.textContent = item.label;
        text.append(title, detail);

        li.appendChild(text);
        todaySchedule.appendChild(li);
    }

    // Next steps: the next unfinished step of each goal
    todaySteps.innerHTML = "";
    let stepCount = 0;
    for (const goal of goals) {
        const index = goal.steps.findIndex((s) => !s.done);
        if (index === -1) continue;
        stepCount++;

        const li = document.createElement("li");
        li.className = "note";

        const text = document.createElement("div");
        text.className = "note-text";

        const label = document.createElement("label");
        label.className = "check";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.addEventListener("change", safe(async () => {
            goal.steps[index].done = true;
            await dbPut(STORE_GOALS, goal);
            await renderToday();
        }));
        const stepText = document.createElement("strong");
        stepText.textContent = goal.steps[index].text;
        label.append(checkbox, stepText);

        const goalName = document.createElement("small");
        goalName.textContent = goal.title;

        text.append(label, goalName);
        li.appendChild(text);
        todaySteps.appendChild(li);
    }
    if (stepCount === 0) {
        addEmptyItem(todaySteps, goals.length === 0
            ? "No goals yet. Create one in Goals."
            : "Every step is done. Time for a new goal?");
    }

    await renderCheckin();
}

// ---------- Daily check-in and streak ----------
const MOODS = [
    { value: 1, face: "😞", label: "Rough" },
    { value: 2, face: "😕", label: "Low" },
    { value: 3, face: "😐", label: "Okay" },
    { value: 4, face: "🙂", label: "Good" },
    { value: 5, face: "😄", label: "Great" }
];

const moodGroup = document.getElementById("mood-buttons");
const checkinNote = document.getElementById("checkin-note");
const checkinMessage = document.getElementById("checkin-message");
const streakLine = document.getElementById("streak-line");
const weekStrip = document.getElementById("week-strip");

let selectedMood = null;
let checkinDay = "";

function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

// A streak is a run of consecutive days that each have a check-in.
// It stays alive until the end of today, so yesterday's run still counts.
function computeStreaks(dates) {
    const cursor = new Date();
    if (!dates.has(toDateString(cursor))) cursor.setDate(cursor.getDate() - 1);

    let current = 0;
    while (dates.has(toDateString(cursor))) {
        current++;
        cursor.setDate(cursor.getDate() - 1);
    }

    let best = 0;
    let run = 0;
    let previous = null;
    for (const date of [...dates].sort()) {
        run = previous !== null && daysBetween(previous, date) === 1 ? run + 1 : 1;
        best = Math.max(best, run);
        previous = date;
    }

    return { current: current, best: best };
}

function buildMoodButtons() {
    moodGroup.innerHTML = "";
    for (const mood of MOODS) {
        const button = document.createElement("button");
        button.className = "mood-button";
        button.setAttribute("aria-pressed", "false");
        button.dataset.mood = String(mood.value);

        const face = document.createElement("span");
        face.className = "face";
        face.textContent = mood.face;
        face.setAttribute("aria-hidden", "true");

        button.append(face, document.createTextNode(mood.label));
        button.addEventListener("click", () => {
            selectedMood = mood.value;
            updateMoodButtons();
        });
        moodGroup.appendChild(button);
    }
}

function updateMoodButtons() {
    moodGroup.querySelectorAll(".mood-button").forEach((button) => {
        button.setAttribute("aria-pressed", String(Number(button.dataset.mood) === selectedMood));
    });
}

async function renderCheckin() {
    const checkins = await dbGetAll(STORE_CHECKINS);
    const byDate = new Map(checkins.map((c) => [c.date, c]));
    const todayString = toDateString(new Date());

    // New day: start with a clean form
    if (checkinDay !== todayString) {
        checkinDay = todayString;
        selectedMood = null;
        checkinNote.value = "";
        checkinMessage.textContent = "";
    }

    // Show today's saved check-in unless the person is already picking something else
    const saved = byDate.get(todayString);
    if (saved && selectedMood === null) {
        selectedMood = saved.mood;
        checkinNote.value = saved.note || "";
    }
    updateMoodButtons();

    const streaks = computeStreaks(new Set(byDate.keys()));
    if (streaks.current === 0) {
        streakLine.textContent = "Check in today to start a streak.";
    } else {
        const days = streaks.current === 1 ? "1-day streak" : streaks.current + "-day streak";
        streakLine.textContent = "🔥 " + days + " (best: " + streaks.best + ")" +
            (saved ? "" : ". Check in today to keep it going.");
    }

    // Last 7 days
    weekStrip.innerHTML = "";
    for (let offset = 6; offset >= 0; offset--) {
        const date = new Date();
        date.setDate(date.getDate() - offset);
        const dateString = toDateString(date);
        const checkin = byDate.get(dateString);
        const mood = checkin ? MOODS.find((m) => m.value === checkin.mood) : null;

        const cell = document.createElement("div");
        cell.className = "week-day" + (dateString === todayString ? " today" : "");

        const name = document.createElement("span");
        name.textContent = date.toLocaleDateString("en-US", { weekday: "short" });

        const face = document.createElement("span");
        face.className = "face";
        face.textContent = mood ? mood.face : "–";
        if (mood) face.setAttribute("title", mood.label);

        cell.append(name, face);
        weekStrip.appendChild(cell);
    }
}

document.getElementById("save-checkin").addEventListener("click", safe(async () => {
    if (selectedMood === null) {
        checkinMessage.textContent = "Pick how today is going first.";
        return;
    }

    await dbPut(STORE_CHECKINS, {
        date: toDateString(new Date()),
        mood: selectedMood,
        note: checkinNote.value.trim(),
        savedAt: Date.now()
    });

    if (selectedMood <= 2) {
        checkinMessage.textContent = "Saved. Rough days happen. A cookie from your jar might help.";
        const openJar = document.createElement("button");
        openJar.className = "secondary inline-action";
        openJar.textContent = "Open Cookie Jar";
        openJar.addEventListener("click", () => showTab("cookie-jar"));
        checkinMessage.appendChild(openJar);
    } else {
        checkinMessage.textContent = "Check-in saved.";
    }

    await renderCheckin();
}));

// ---------- Focus timer (Pomodoro) ----------
const TIMER_KEY = "nexora-timer";
const timerModeLabel = document.getElementById("timer-mode");
const timerDisplay = document.getElementById("timer-display");
const timerProgress = document.getElementById("timer-progress");
const timerToggle = document.getElementById("timer-toggle");
const timerMessage = document.getElementById("timer-message");
const focusStats = document.getElementById("focus-stats");
const focusMinutesInput = document.getElementById("focus-minutes");
const breakMinutesInput = document.getElementById("break-minutes");

let focusMinutes = 25;
let breakMinutes = 5;
const timer = { mode: "focus", totalMs: 0, remainingMs: 0, endAt: 0, running: false };
let timerInterval = null;
let audioContext = null;

function loadTimerSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(TIMER_KEY) || "{}");
        if (saved.focus >= 1 && saved.focus <= 120) focusMinutes = saved.focus;
        if (saved.rest >= 1 && saved.rest <= 60) breakMinutes = saved.rest;
    } catch (error) {
        // Use the defaults
    }
    focusMinutesInput.value = focusMinutes;
    breakMinutesInput.value = breakMinutes;
}

function saveTimerSettings() {
    try {
        localStorage.setItem(TIMER_KEY, JSON.stringify({ focus: focusMinutes, rest: breakMinutes }));
    } catch (error) {
        // Storage unavailable: the lengths still apply until the page is closed
    }
}

function setMode(mode) {
    clearInterval(timerInterval);
    timer.mode = mode;
    timer.totalMs = (mode === "focus" ? focusMinutes : breakMinutes) * 60000;
    timer.remainingMs = timer.totalMs;
    timer.endAt = 0;
    timer.running = false;
}

function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return minutes + ":" + seconds;
}

function renderTimer() {
    const modeName = timer.mode === "focus" ? "Focus" : "Break";
    timerModeLabel.textContent = modeName;
    timerDisplay.textContent = formatTime(timer.remainingMs);

    const elapsed = timer.totalMs === 0 ? 0 : 1 - timer.remainingMs / timer.totalMs;
    timerProgress.style.width = Math.round(elapsed * 100) + "%";

    if (timer.running) {
        timerToggle.textContent = "Pause";
    } else {
        timerToggle.textContent = timer.remainingMs < timer.totalMs ? "Resume" : "Start";
    }

    // Show the countdown in the browser tab while it runs
    document.title = timer.running ? formatTime(timer.remainingMs) + " " + modeName + " - Nexora" : "Nexora";
}

function beep() {
    try {
        if (!audioContext) return;
        const start = audioContext.currentTime;
        [0, 0.25, 0.5].forEach((offset) => {
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            oscillator.frequency.value = 880;
            oscillator.connect(gain);
            gain.connect(audioContext.destination);
            gain.gain.setValueAtTime(0.0001, start + offset);
            gain.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.2);
            oscillator.start(start + offset);
            oscillator.stop(start + offset + 0.22);
        });
    } catch (error) {
        // Sound is optional
    }
}

async function completeTimer() {
    const finished = timer.mode;
    const finishedMinutes = Math.round(timer.totalMs / 60000);

    setMode(finished === "focus" ? "break" : "focus");
    renderTimer();
    beep();
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

    if (finished === "focus") {
        timerMessage.textContent = "Focus session done. Take a break when you are ready.";
        await dbPut(STORE_SESSIONS, {
            date: toDateString(new Date()),
            minutes: finishedMinutes,
            endedAt: Date.now()
        });
        await renderFocusStats();
        await notify("Focus session done", "Nice work. Time for a break.");
    } else {
        timerMessage.textContent = "Break is over. Ready for another focus session?";
        await notify("Break is over", "Ready for another focus session?");
    }
}

function tick() {
    if (!timer.running) return;
    const remaining = timer.endAt - Date.now();
    if (remaining <= 0) {
        completeTimer().catch(console.error);
        return;
    }
    timer.remainingMs = remaining;
    renderTimer();
}

async function renderFocusStats() {
    const sessions = await dbGetAll(STORE_SESSIONS);
    const todayString = toDateString(new Date());
    const today = sessions.filter((s) => s.date === todayString);
    const minutes = today.reduce((sum, s) => sum + s.minutes, 0);

    if (today.length === 0) {
        focusStats.textContent = "No focus sessions yet today.";
    } else {
        focusStats.textContent = today.length + (today.length === 1 ? " session, " : " sessions, ") +
            minutes + " minutes of focus today.";
    }
}

timerToggle.addEventListener("click", () => {
    if (timer.running) {
        timer.remainingMs = Math.max(0, timer.endAt - Date.now());
        timer.running = false;
        clearInterval(timerInterval);
    } else {
        // Browsers only allow sound after a tap, so the audio is prepared here
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (error) {
                audioContext = null;
            }
        }
        if (audioContext && audioContext.state === "suspended") audioContext.resume();

        timer.endAt = Date.now() + timer.remainingMs;
        timer.running = true;
        timerMessage.textContent = "";
        timerInterval = setInterval(tick, 250);
    }
    renderTimer();
});

document.getElementById("timer-reset").addEventListener("click", () => {
    setMode(timer.mode);
    timerMessage.textContent = "";
    renderTimer();
});

document.getElementById("timer-skip").addEventListener("click", () => {
    setMode(timer.mode === "focus" ? "break" : "focus");
    timerMessage.textContent = "";
    renderTimer();
});

function onTimerLengthChange() {
    const focus = parseInt(focusMinutesInput.value, 10);
    const rest = parseInt(breakMinutesInput.value, 10);
    if (focus >= 1 && focus <= 120) focusMinutes = focus;
    if (rest >= 1 && rest <= 60) breakMinutes = rest;
    saveTimerSettings();

    if (!timer.running) {
        setMode(timer.mode);
        renderTimer();
    }
}

focusMinutesInput.addEventListener("change", onTimerLengthChange);
breakMinutesInput.addEventListener("change", onTimerLengthChange);

// ---------- Reminder alerts (while the app is open) ----------
function loadFired() {
    try {
        return JSON.parse(localStorage.getItem(FIRED_KEY) || "[]");
    } catch (error) {
        return [];
    }
}

function saveFired(list) {
    try {
        localStorage.setItem(FIRED_KEY, JSON.stringify(list.slice(-200)));
    } catch (error) {
        // Alerts may repeat if storage is unavailable
    }
}

async function checkReminders() {
    if (!notificationsSupported() || Notification.permission !== "granted") return;

    const now = Date.now();
    const hour = 60 * 60 * 1000;

    // Notes: alert once, within an hour of the reminder time
    const notes = await dbGetAll(STORE_NOTES);
    for (const note of notes) {
        if (note.due === null || note.notified) continue;
        if (note.due <= now && now - note.due < hour) {
            note.notified = true;
            await dbPut(STORE_NOTES, note);
            await notify(note.title, "Reminder");
        }
    }

    // Timed events: alert once when they start (also for weekly repeats)
    const fired = loadFired();
    let changed = false;
    const todayString = toDateString(new Date());
    const events = await dbGetAll(STORE_EVENTS);
    for (const event of events) {
        if (!event.time || !occursOn(event, todayString)) continue;

        const start = new Date(todayString + "T" + event.time).getTime();
        const key = "event-" + event.id + "-" + todayString;
        if (start <= now && now - start < 10 * 60 * 1000 && !fired.includes(key)) {
            fired.push(key);
            changed = true;
            await notify(event.title, "Starting now");
        }
    }
    if (changed) saveFired(fired);
}

// ---------- Notification settings ----------
const notificationStatus = document.getElementById("notification-status");

function updateNotificationStatus() {
    if (!notificationsSupported()) {
        notificationStatus.textContent = "This browser does not support notifications.";
    } else if (Notification.permission === "granted") {
        notificationStatus.textContent = "Notifications are on.";
    } else if (Notification.permission === "denied") {
        notificationStatus.textContent = "Notifications are blocked. Allow them for this site in your browser settings.";
    } else {
        notificationStatus.textContent = "Notifications are off. Tap the button to turn them on.";
    }
}

document.getElementById("enable-notifications").addEventListener("click", safe(async () => {
    if (notificationsSupported()) {
        await Notification.requestPermission();
        if (Notification.permission === "granted") {
            await notify("Notifications are on", "Nexora will alert you about reminders and focus sessions.");
        }
    }
    updateNotificationStatus();
}));

// ---------- Backup: Export / Import ----------
const backupStatus = document.getElementById("backup-status");

document.getElementById("export-data").addEventListener("click", safe(async () => {
    const data = {
        app: "nexora",
        version: 3,
        exportedAt: new Date().toISOString(),
        cookies: await dbGetAll(STORE_COOKIES),
        notes: await dbGetAll(STORE_NOTES),
        events: await dbGetAll(STORE_EVENTS),
        goals: await dbGetAll(STORE_GOALS),
        checkins: await dbGetAll(STORE_CHECKINS),
        sessions: await dbGetAll(STORE_SESSIONS)
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "nexora-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    backupStatus.textContent = "Backup file downloaded. Keep it somewhere safe.";
}));

document.getElementById("import-file").addEventListener("change", safe(async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    let data;
    try {
        data = JSON.parse(await file.text());
    } catch (error) {
        backupStatus.textContent = "Import failed. The file is not valid JSON.";
        event.target.value = "";
        return;
    }

    const isValid = data.app === "nexora" &&
        Array.isArray(data.cookies) &&
        Array.isArray(data.notes);
    if (!isValid) {
        backupStatus.textContent = "This is not a valid Nexora backup file.";
        event.target.value = "";
        return;
    }

    if (!confirm("Importing will replace ALL current data in this app. Continue?")) {
        event.target.value = "";
        return;
    }

    // Older backups have no events, goals, check-ins or focus sessions
    const events = Array.isArray(data.events) ? data.events : [];
    const goals = Array.isArray(data.goals) ? data.goals : [];
    const checkins = Array.isArray(data.checkins)
        ? data.checkins.filter((c) => c && typeof c.date === "string")
        : [];
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];

    await dbReplaceAll(STORE_COOKIES, data.cookies);
    await dbReplaceAll(STORE_NOTES, data.notes);
    await dbReplaceAll(STORE_EVENTS, events);
    await dbReplaceAll(STORE_GOALS, goals);
    await dbReplaceAll(STORE_CHECKINS, checkins);
    await dbReplaceAll(STORE_SESSIONS, sessions);

    await renderFocusStats();
    await renderToday();
    await renderNotes();
    await renderCalendar();
    await renderGoals();
    await renderJar();

    backupStatus.textContent = "Import complete: " + data.cookies.length + " cookies, " +
        data.notes.length + " notes, " + events.length + " events and " +
        goals.length + " goals restored.";
    event.target.value = "";
}));

// ---------- Theme (Auto / Light / Dark) ----------
const THEME_KEY = "nexora-theme";
const themeButtons = document.querySelectorAll("[data-theme-choice]");
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function savedTheme() {
    try {
        return localStorage.getItem(THEME_KEY) || "auto";
    } catch (error) {
        return "auto";
    }
}

function applyTheme(choice) {
    const resolved = choice === "auto" ? (darkQuery.matches ? "dark" : "light") : choice;
    document.documentElement.dataset.theme = resolved;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#1b1840" : "#dfe6ff");

    themeButtons.forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
    });
}

themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
        try {
            localStorage.setItem(THEME_KEY, button.dataset.themeChoice);
        } catch (error) {
            // Storage unavailable: the choice still applies until the page is closed
        }
        applyTheme(button.dataset.themeChoice);
    });
});

darkQuery.addEventListener("change", () => {
    if (savedTheme() === "auto") applyTheme("auto");
});

applyTheme(savedTheme());

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

    if (name === "today") renderToday();
    if (name === "calendar") renderCalendar();
    if (name === "goals") renderGoals();
    if (name === "notes") renderNotes();
    if (name === "cookie-jar") renderJar();
    if (name === "focus") renderFocusStats();

    window.scrollTo(0, 0);
}

tabButtons.forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
});

document.getElementById("settings-button").addEventListener("click", () => showTab("settings"));

// ---------- Start ----------
eventDate.value = selectedDate;

buildMoodButtons();
loadTimerSettings();
setMode("focus");
renderTimer();
updateNotificationStatus();

Promise.all([
    renderToday(), renderNotes(), renderCalendar(), renderGoals(), renderJar(), renderFocusStats()
]).catch((error) => console.error(error));

checkReminders().catch(console.error);

// Every 30 seconds: flag due reminders, send alerts, refresh the Today tab
setInterval(() => {
    renderNotes().catch(console.error);
    checkReminders().catch(console.error);
    if (!document.getElementById("today").hidden) {
        renderToday().catch(console.error);
    }
}, 30000);

// Catch up straight away when the app comes back to the screen
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        tick();
        checkReminders().catch(console.error);
    }
});

// ---------- PWA: register the service worker ----------
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js");
}