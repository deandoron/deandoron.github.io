const DB_NAME = "apartment-board-db";
const DB_VERSION = 1;
const STATE_KEY = "main";
const DEFAULT_TAGS = ["Dean", "Avital", "Both"];
const AUTH_SESSION_KEY = "apartment-board-unlocked";
const PASSWORD_HASH = "a30bab50672952f8a8bbb133d63031da3074a79a713ac4a416e4aaaf63e3f0b3";

const authForm = document.querySelector("#authForm");
const passwordInput = document.querySelector("#passwordInput");
const authMessage = document.querySelector("#authMessage");
const roomTabs = document.querySelector("#roomTabs");
const addRoomBtn = document.querySelector("#addRoomBtn");
const deleteRoomBtn = document.querySelector("#deleteRoomBtn");
const roomNameInput = document.querySelector("#roomNameInput");
const roomNotes = document.querySelector("#roomNotes");
const roomPanel = document.querySelector("#roomPanel");
const dropZone = document.querySelector("#dropZone");
const dropStatus = document.querySelector("#dropStatus");
const fileInput = document.querySelector("#fileInput");
const chooseFilesBtn = document.querySelector("#chooseFilesBtn");
const thumbGrid = document.querySelector("#thumbGrid");
const detailPanel = document.querySelector("#detailPanel");
const roomTabTemplate = document.querySelector("#roomTabTemplate");
const thumbTemplate = document.querySelector("#thumbTemplate");

let db;
let state;
let saveStateTimer;
let dropStatusTimer;
const imageRecords = new Map();

boot();

function boot() {
  if (sessionStorage.getItem(AUTH_SESSION_KEY) === "true") {
    unlockApp();
    return;
  }

  authForm.addEventListener("submit", handlePasswordSubmit);
  passwordInput.focus();
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  authMessage.textContent = "";

  if (!crypto.subtle) {
    authMessage.textContent = "This browser cannot check the password securely.";
    return;
  }

  const hash = await sha256(passwordInput.value);
  if (hash !== PASSWORD_HASH) {
    authMessage.textContent = "Wrong password.";
    passwordInput.select();
    return;
  }

  sessionStorage.setItem(AUTH_SESSION_KEY, "true");
  passwordInput.value = "";
  unlockApp();
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function unlockApp() {
  document.body.classList.remove("auth-locked");
  if (!db) init();
}

async function init() {
  db = await openDatabase();
  await loadInitialState();
  wireEvents();
  render();
}

function wireEvents() {
  addRoomBtn.addEventListener("click", addRoom);
  deleteRoomBtn.addEventListener("click", deleteActiveRoom);

  roomNameInput.addEventListener("input", () => {
    const room = getActiveRoom();
    if (!room) return;
    room.name = roomNameInput.value;
    queueStateSave();
    renderTabs();
  });

  roomNotes.addEventListener("input", () => {
    const room = getActiveRoom();
    if (!room) return;
    room.notes = roomNotes.value;
    queueStateSave();
  });

  chooseFilesBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    await addFiles(fileInput.files);
    fileInput.value = "";
  });

  dropZone.addEventListener("click", (event) => {
    if (event.target !== chooseFilesBtn) fileInput.click();
  });

  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      roomPanel.classList.add("is-dragover");
      dropZone.classList.add("is-dragover");
    }, true);
  });

  dropZone.addEventListener("dragleave", (event) => {
    if (dropZone.contains(event.relatedTarget)) return;
    roomPanel.classList.remove("is-dragover");
    dropZone.classList.remove("is-dragover");
  }, true);

  dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    roomPanel.classList.remove("is-dragover");
    dropZone.classList.remove("is-dragover");
    await addDroppedData(event.dataTransfer);
  }, true);

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  window.addEventListener("drop", (event) => {
    if (!dropZone.contains(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  window.addEventListener("beforeunload", () => {
    if (saveStateTimer) {
      clearTimeout(saveStateTimer);
      saveState();
    }
  });
}

async function addDroppedData(dataTransfer) {
  const files = getDroppedImageFiles(dataTransfer);
  if (files.length) {
    const addedCount = await addFiles(files);
    setDropStatus(`Added ${addedCount} image${addedCount === 1 ? "" : "s"}.`, true);
    return;
  }

  const urls = getDroppedImageUrls(dataTransfer);
  if (!urls.length) {
    setDropStatus("Drop an image file, or use Add images.");
    return;
  }

  setDropStatus("Importing dragged image...");
  const urlFiles = await getImageFilesFromUrls(urls);
  if (!urlFiles.length) {
    setDropStatus("Could not import that image. Save it first, then drag the file here.");
    return;
  }

  const addedCount = await addFiles(urlFiles);
  setDropStatus(`Added ${addedCount} image${addedCount === 1 ? "" : "s"}.`, true);
}

function getDroppedImageFiles(dataTransfer) {
  const fileList = Array.from(dataTransfer?.files || []);
  const itemFiles = Array.from(dataTransfer?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);

  return mergeUniqueFiles([...fileList, ...itemFiles]).filter(isImageFile);
}

function getDroppedImageUrls(dataTransfer) {
  const urls = [];
  const uriList = dataTransfer.getData("text/uri-list");
  const plainText = dataTransfer.getData("text/plain");
  const html = dataTransfer.getData("text/html");

  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim();
    if (value && !value.startsWith("#")) urls.push(value);
  }

  if (plainText.trim()) urls.push(plainText.trim());

  if (html.trim()) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of doc.querySelectorAll("img[src]")) {
      urls.push(img.getAttribute("src"));
    }
    for (const link of doc.querySelectorAll("a[href]")) {
      urls.push(link.getAttribute("href"));
    }
  }

  return mergeUnique(
    urls
      .filter(Boolean)
      .map((url) => url.trim())
      .filter((url) => url.startsWith("data:image/") || /^https?:\/\//i.test(url))
  );
}

async function getImageFilesFromUrls(urls) {
  const files = [];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const type = blob.type || inferImageType(url);
      if (!type.startsWith("image/")) continue;
      const name = getFileNameFromUrl(url);
      files.push(new File([blob], name, { type }));
    } catch {
      // Some sites block cross-origin reads. In that case the user needs to save the image first.
    }
  }
  return files;
}

function mergeUniqueFiles(files) {
  const seen = new Set();
  return files.filter((file) => {
    const key = `${file.name}-${file.size}-${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(file.name);
}

function inferImageType(url) {
  const cleanUrl = url.split(/[?#]/)[0];
  const extension = cleanUrl.split(".").pop()?.toLowerCase();
  const types = {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  return types[extension] || "";
}

function getFileNameFromUrl(url) {
  if (url.startsWith("data:image/")) return "dragged-image";
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "dragged-image");
  } catch {
    return "dragged-image";
  }
}

function setDropStatus(message, clearSoon = false) {
  clearTimeout(dropStatusTimer);
  dropStatus.textContent = message;
  if (clearSoon) {
    dropStatusTimer = setTimeout(() => {
      dropStatus.textContent = "";
    }, 2600);
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("state")) {
        database.createObjectStore("state", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("images")) {
        database.createObjectStore("images", { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadInitialState() {
  const savedState = await getFromStore("state", STATE_KEY);
  const savedImages = await getAllFromStore("images");

  imageRecords.clear();
  for (const image of savedImages) {
    if (!image.blob) continue;
    imageRecords.set(image.id, {
      ...image,
      tags: Array.isArray(image.tags) ? image.tags : [],
      note: image.note || "",
      url: URL.createObjectURL(image.blob),
    });
  }

  if (savedState) {
    state = normalizeState(savedState);
  } else {
    const kitchen = createRoom("Kitchen");
    const livingRoom = createRoom("Living room");
    state = {
      id: STATE_KEY,
      rooms: [kitchen, livingRoom],
      activeRoomId: kitchen.id,
      activeImageId: null,
      tags: [...DEFAULT_TAGS],
    };
    await saveState();
  }

  removeMissingImageRefs();
  ensureValidSelection();
}

function normalizeState(savedState) {
  const rooms = Array.isArray(savedState.rooms) ? savedState.rooms : [];
  const normalizedRooms = rooms.map((room) => ({
    id: room.id || makeId(),
    name: room.name || "Untitled room",
    notes: room.notes || "",
    imageIds: Array.isArray(room.imageIds) ? room.imageIds : [],
  }));

  if (!normalizedRooms.length) {
    normalizedRooms.push(createRoom("Kitchen"));
  }

  return {
    id: STATE_KEY,
    rooms: normalizedRooms,
    activeRoomId: savedState.activeRoomId || normalizedRooms[0].id,
    activeImageId: savedState.activeImageId || null,
    tags: mergeUnique([...DEFAULT_TAGS, ...(Array.isArray(savedState.tags) ? savedState.tags : [])]),
  };
}

function removeMissingImageRefs() {
  for (const room of state.rooms) {
    room.imageIds = room.imageIds.filter((id) => imageRecords.has(id));
  }
}

function ensureValidSelection() {
  if (!state.rooms.some((room) => room.id === state.activeRoomId)) {
    state.activeRoomId = state.rooms[0]?.id || null;
  }

  const room = getActiveRoom();
  if (!room) {
    state.activeImageId = null;
    return;
  }

  if (!room.imageIds.includes(state.activeImageId)) {
    state.activeImageId = room.imageIds[0] || null;
  }
}

function createRoom(name) {
  return {
    id: makeId(),
    name,
    notes: "",
    imageIds: [],
  };
}

function addRoom() {
  const room = createRoom("New room");
  state.rooms.push(room);
  state.activeRoomId = room.id;
  state.activeImageId = null;
  queueStateSave();
  render();
  roomNameInput.focus();
  roomNameInput.select();
}

async function deleteActiveRoom() {
  const room = getActiveRoom();
  if (!room || state.rooms.length <= 1) return;

  const confirmed = window.confirm(`Delete "${room.name || "Untitled room"}" and its images?`);
  if (!confirmed) return;

  for (const imageId of room.imageIds) {
    await deleteImageRecord(imageId);
  }

  state.rooms = state.rooms.filter((candidate) => candidate.id !== room.id);
  state.activeRoomId = state.rooms[0]?.id || null;
  state.activeImageId = getActiveRoom()?.imageIds[0] || null;
  await saveState();
  render();
}

async function addFiles(fileList) {
  const room = getActiveRoom();
  if (!room) return 0;

  const files = Array.from(fileList || []).filter(isImageFile);
  if (!files.length) return 0;

  for (const file of files) {
    const image = {
      id: makeId(),
      roomId: room.id,
      name: file.name || "Image",
      type: file.type,
      size: file.size,
      createdAt: new Date().toISOString(),
      note: "",
      tags: [],
      blob: file,
      url: URL.createObjectURL(file),
    };
    imageRecords.set(image.id, image);
    room.imageIds.push(image.id);
    await putInStore("images", imageForStorage(image));
    state.activeImageId = image.id;
  }

  await saveState();
  render();
  return files.length;
}

async function deleteSelectedImage() {
  const room = getActiveRoom();
  const image = getActiveImage();
  if (!room || !image) return;

  await deleteImageRecord(image.id);
  room.imageIds = room.imageIds.filter((id) => id !== image.id);
  state.activeImageId = room.imageIds[0] || null;
  await saveState();
  render();
}

async function deleteImageRecord(imageId) {
  const image = imageRecords.get(imageId);
  if (image?.url) URL.revokeObjectURL(image.url);
  imageRecords.delete(imageId);
  await deleteFromStore("images", imageId);
}

function render() {
  ensureValidSelection();
  renderTabs();
  renderRoom();
  renderThumbs();
  renderDetail();
}

function renderTabs() {
  roomTabs.replaceChildren();

  for (const room of state.rooms) {
    const tab = roomTabTemplate.content.firstElementChild.cloneNode(true);
    const name = tab.querySelector(".room-tab-name");
    const count = tab.querySelector(".room-tab-count");

    name.textContent = room.name || "Untitled room";
    count.textContent = room.imageIds.length.toString();
    tab.id = `tab-${room.id}`;
    tab.setAttribute("aria-selected", room.id === state.activeRoomId ? "true" : "false");
    tab.addEventListener("click", () => {
      state.activeRoomId = room.id;
      state.activeImageId = room.imageIds[0] || null;
      queueStateSave();
      render();
    });

    roomTabs.append(tab);
  }
}

function renderRoom() {
  const room = getActiveRoom();
  const hasRoom = Boolean(room);
  roomNameInput.disabled = !hasRoom;
  roomNotes.disabled = !hasRoom;
  deleteRoomBtn.disabled = !hasRoom || state.rooms.length <= 1;

  roomNameInput.value = room?.name || "";
  roomNotes.value = room?.notes || "";
}

function renderThumbs() {
  const room = getActiveRoom();
  thumbGrid.replaceChildren();
  if (!room) return;

  for (const imageId of room.imageIds) {
    const image = imageRecords.get(imageId);
    if (!image) continue;

    const thumb = thumbTemplate.content.firstElementChild.cloneNode(true);
    const img = thumb.querySelector("img");
    const caption = thumb.querySelector(".thumb-caption");
    const tags = thumb.querySelector(".thumb-tags");

    img.src = image.url;
    img.alt = image.note || "Apartment inspiration image";
    caption.textContent = image.note || "No note yet";
    thumb.setAttribute("aria-selected", image.id === state.activeImageId ? "true" : "false");
    thumb.addEventListener("click", () => {
      state.activeImageId = image.id;
      queueStateSave();
      renderThumbs();
      renderDetail();
    });

    for (const tag of image.tags) {
      const chip = document.createElement("span");
      chip.className = "mini-tag";
      chip.textContent = `#${tag}`;
      tags.append(chip);
    }

    thumbGrid.append(thumb);
  }
}

function renderDetail() {
  const image = getActiveImage();
  detailPanel.replaceChildren();

  if (!image) {
    const empty = document.createElement("div");
    empty.className = "empty-detail";
    empty.textContent = "No image selected";
    detailPanel.append(empty);
    return;
  }

  const imageWrap = document.createElement("div");
  imageWrap.className = "detail-image-wrap";

  const img = document.createElement("img");
  img.src = image.url;
  img.alt = image.note || "Apartment inspiration image";
  imageWrap.append(img);

  const body = document.createElement("div");
  body.className = "detail-body";

  const removeButton = document.createElement("button");
  removeButton.className = "ghost-button danger";
  removeButton.type = "button";
  removeButton.textContent = "Remove image";
  removeButton.addEventListener("click", deleteSelectedImage);

  const noteField = document.createElement("label");
  noteField.className = "detail-field";

  const noteLabel = document.createElement("span");
  noteLabel.className = "field-label";
  noteLabel.textContent = "Image note";

  const noteInput = document.createElement("input");
  noteInput.className = "image-note-input";
  noteInput.type = "text";
  noteInput.dir = "auto";
  noteInput.value = image.note || "";
  noteInput.placeholder = "What did you like?";
  noteInput.addEventListener("input", () => {
    image.note = noteInput.value;
    saveImageMeta(image);
    renderThumbs();
  });

  noteField.append(noteLabel, noteInput);

  const tagEditor = document.createElement("div");
  tagEditor.className = "tag-editor";

  const tagLabel = document.createElement("div");
  tagLabel.className = "field-label";
  tagLabel.textContent = "Hashtags";

  const tagList = document.createElement("div");
  tagList.className = "tag-list";

  for (const tag of state.tags) {
    const chip = document.createElement("button");
    chip.className = "tag-chip";
    chip.type = "button";
    chip.textContent = `#${tag}`;
    chip.setAttribute("aria-pressed", image.tags.includes(tag) ? "true" : "false");
    chip.classList.toggle("is-active", image.tags.includes(tag));
    chip.addEventListener("click", () => toggleImageTag(image, tag));
    tagList.append(chip);
  }

  const addRow = document.createElement("form");
  addRow.className = "tag-add-row";
  addRow.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = addRow.querySelector(".tag-input");
    addTagToImage(image, input.value);
    input.value = "";
  });

  const tagInput = document.createElement("input");
  tagInput.className = "tag-input";
  tagInput.type = "text";
  tagInput.dir = "auto";
  tagInput.placeholder = "Add hashtag";
  tagInput.autocomplete = "off";

  const tagButton = document.createElement("button");
  tagButton.className = "tag-add-button";
  tagButton.type = "submit";
  tagButton.textContent = "Add";

  addRow.append(tagInput, tagButton);
  tagEditor.append(tagLabel, tagList, addRow);

  body.append(noteField, tagEditor, removeButton);
  detailPanel.append(imageWrap, body);
}

function toggleImageTag(image, tag) {
  if (image.tags.includes(tag)) {
    image.tags = image.tags.filter((candidate) => candidate !== tag);
  } else {
    image.tags = [...image.tags, tag];
  }
  saveImageMeta(image);
  renderThumbs();
  renderDetail();
}

function addTagToImage(image, rawTag) {
  const tag = normalizeTag(rawTag);
  if (!tag) return;

  if (!state.tags.includes(tag)) {
    state.tags.push(tag);
    queueStateSave();
  }

  if (!image.tags.includes(tag)) {
    image.tags.push(tag);
    saveImageMeta(image);
  }

  renderThumbs();
  renderDetail();
}

function normalizeTag(rawTag) {
  return rawTag
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 32);
}

function getActiveRoom() {
  return state.rooms.find((room) => room.id === state.activeRoomId) || null;
}

function getActiveImage() {
  const room = getActiveRoom();
  if (!room || !state.activeImageId || !room.imageIds.includes(state.activeImageId)) return null;
  return imageRecords.get(state.activeImageId) || null;
}

function queueStateSave() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveState();
  }, 180);
}

function saveState() {
  clearTimeout(saveStateTimer);
  saveStateTimer = null;
  return putInStore("state", {
    id: STATE_KEY,
    rooms: state.rooms,
    activeRoomId: state.activeRoomId,
    activeImageId: state.activeImageId,
    tags: state.tags,
  });
}

function saveImageMeta(image) {
  putInStore("images", imageForStorage(image));
}

function imageForStorage(image) {
  return {
    id: image.id,
    roomId: image.roomId,
    name: image.name,
    type: image.type,
    size: image.size,
    createdAt: image.createdAt,
    note: image.note || "",
    tags: image.tags || [],
    blob: image.blob,
  };
}

function getFromStore(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllFromStore(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function putInStore(storeName, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).put(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteFromStore(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function mergeUnique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
