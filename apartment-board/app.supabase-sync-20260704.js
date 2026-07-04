const DB_NAME = "apartment-board-db";
const DB_VERSION = 1;
const STATE_KEY = "main";
const DEFAULT_TAGS = ["Dean", "Avital", "Both"];
const SHARED_DATA_URL = "./shared-data.20260704.json";
const SHARED_DATA_VERSION = "2026-07-04-current-chrome";
const PUBLIC_SITE_URL = "https://deandoron.github.io/apartment-board/";
const SUPABASE_URL = "https://gctwgqxyoqrnhmpbvuvp.supabase.co";
const SUPABASE_KEY = "sb_publishable_cUlIXL_18qhrBrPPOlhIVw_GwPKNljH";
const SUPABASE_TABLE = "apartment_board_state";
const SUPABASE_BOARD_ID = "main";
const SUPABASE_STORAGE_BUCKET = "apartment-board-images";
const REMOTE_SAVE_DELAY = 700;
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
const syncStatus = document.querySelector("#syncStatus");
const roomTabTemplate = document.querySelector("#roomTabTemplate");
const thumbTemplate = document.querySelector("#thumbTemplate");

let db;
let state;
let saveStateTimer;
let remoteSaveTimer;
let remoteSaveInFlight = false;
let remoteSaveRequested = false;
let suppressRemoteSave = true;
let dropStatusTimer;
let draggedRoomId = "";
let suppressNextTabClick = false;
let remoteUpdatedAt = "";
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
  suppressRemoteSave = false;
  await initializeRemoteBoard();
  render();
}

function wireEvents() {
  addRoomBtn.addEventListener("click", addRoom);
  deleteRoomBtn.addEventListener("click", deleteActiveRoom);
  roomTabs.addEventListener("dragover", handleRoomTabsDragOver);
  roomTabs.addEventListener("drop", handleRoomTabsDrop);
  roomTabs.addEventListener("dragleave", (event) => {
    if (!roomTabs.contains(event.relatedTarget)) clearAllRoomTabDragStates();
  });

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
  const { files: urlFiles, importedUrls } = await getImageFilesFromUrls(urls);
  let addedCount = 0;

  if (urlFiles.length) {
    addedCount += await addFiles(urlFiles);
  }

  const linkedUrls = urls.filter((url) => !importedUrls.has(url));
  if (linkedUrls.length) {
    addedCount += await addRemoteImages(linkedUrls);
  }

  if (!addedCount) {
    setDropStatus("Could not import that image. Try Add images instead.");
    return;
  }

  const suffix = linkedUrls.length ? " Linked images need internet access to display." : "";
  setDropStatus(`Added ${addedCount} image${addedCount === 1 ? "" : "s"}.${suffix}`, true);
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
  const imageUrls = [];
  const candidateUrls = [];
  const downloadUrl = dataTransfer.getData("DownloadURL");
  const uriList = dataTransfer.getData("text/uri-list");
  const plainText = dataTransfer.getData("text/plain");
  const html = dataTransfer.getData("text/html");

  const chromeDownloadUrl = parseChromeDownloadUrl(downloadUrl);
  if (chromeDownloadUrl) imageUrls.push(chromeDownloadUrl);

  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim();
    if (value && !value.startsWith("#")) candidateUrls.push(value);
  }

  if (plainText.trim()) candidateUrls.push(plainText.trim());

  if (html.trim()) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const img of doc.querySelectorAll("img[src]")) {
      imageUrls.push(img.getAttribute("src"));
    }
    for (const link of doc.querySelectorAll("a[href]")) {
      candidateUrls.push(link.getAttribute("href"));
    }
  }

  return mergeUnique(
    [
      ...imageUrls,
      ...candidateUrls.filter(looksLikeImageUrl),
    ]
      .filter(Boolean)
      .map((url) => url.trim())
      .filter((url) => url.startsWith("data:image/") || /^https?:\/\//i.test(url))
  );
}

async function getImageFilesFromUrls(urls) {
  const files = [];
  const importedUrls = new Set();
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const type = blob.type || inferImageType(url);
      if (!type.startsWith("image/")) continue;
      const name = getFileNameFromUrl(url);
      files.push(new File([blob], name, { type }));
      importedUrls.add(url);
    } catch {
      // Some sites block cross-origin reads. Those are saved as linked images instead.
    }
  }
  return { files, importedUrls };
}

function parseChromeDownloadUrl(value) {
  const match = value.match(/^[^:]+:[^:]*:(.+)$/);
  return match?.[1] || "";
}

function looksLikeImageUrl(url) {
  if (url.startsWith("data:image/")) return true;
  const cleanUrl = url.split(/[?#]/)[0].toLowerCase();
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/.test(cleanUrl);
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
  const sharedSnapshot = await loadSharedSnapshot();
  let savedState = await getFromStore("state", STATE_KEY);

  if (shouldImportSharedSnapshot(sharedSnapshot, savedState)) {
    await importSharedSnapshot(sharedSnapshot);
    savedState = await getFromStore("state", STATE_KEY);
  }

  const savedImages = await getAllFromStore("images");

  imageRecords.clear();
  for (const image of savedImages) {
    if (!image.blob && !image.remoteUrl) continue;
    imageRecords.set(image.id, {
      ...image,
      tags: Array.isArray(image.tags) ? image.tags : [],
      note: image.note || "",
      remoteUrl: image.remoteUrl || "",
      storagePath: image.storagePath || "",
      url: image.blob ? URL.createObjectURL(image.blob) : image.remoteUrl,
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
      sharedVersion: sharedSnapshot?.version || "",
    };
    await saveState();
  }

  removeMissingImageRefs();
  ensureValidSelection();
}

async function initializeRemoteBoard() {
  if (!isSupabaseConfigured()) return;

  setSyncStatus("Syncing...");

  try {
    const remoteBoard = await fetchRemoteBoard();

    if (remoteBoard) {
      await importSharedSnapshot(remoteBoard.data);
      remoteUpdatedAt = remoteBoard.updatedAt || "";
      await reloadStateFromStores();
      setSyncStatus("Synced");
      return;
    }

    await saveRemoteBoardNow();
    setSyncStatus("Synced");
  } catch (error) {
    console.error(error);
    setSyncStatus("Local only - run Supabase setup");
  }
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function fetchRemoteBoard() {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?id=eq.${encodeURIComponent(
    SUPABASE_BOARD_ID,
  )}&select=data,updated_at&limit=1`;
  const response = await supabaseFetch(url);
  if (!response.ok) throw new Error(await responseText(response, "Could not load Supabase board."));

  const rows = await response.json();
  const row = rows[0];
  if (!row?.data) return null;

  return {
    data: normalizeRemoteBoard(row.data),
    updatedAt: row.updated_at || row.data.updatedAt || "",
  };
}

function normalizeRemoteBoard(data) {
  return {
    ...data,
    version: data.version || "supabase",
    state: data.state || {},
    images: Array.isArray(data.images) ? data.images : [],
  };
}

async function reloadStateFromStores() {
  const savedState = await getFromStore("state", STATE_KEY);
  const savedImages = await getAllFromStore("images");

  imageRecords.clear();
  for (const image of savedImages) {
    if (!image.blob && !image.remoteUrl) continue;
    imageRecords.set(image.id, {
      ...image,
      tags: Array.isArray(image.tags) ? image.tags : [],
      note: image.note || "",
      remoteUrl: image.remoteUrl || "",
      storagePath: image.storagePath || "",
      url: image.blob ? URL.createObjectURL(image.blob) : image.remoteUrl,
    });
  }

  if (savedState) state = normalizeState(savedState);
  removeMissingImageRefs();
  ensureValidSelection();
}

async function loadSharedSnapshot() {
  try {
    const response = await fetch(SHARED_DATA_URL, { cache: "no-store" });
    if (!response.ok) return null;
    const snapshot = await response.json();
    if (snapshot?.version !== SHARED_DATA_VERSION) return null;
    return snapshot;
  } catch {
    return null;
  }
}

function shouldImportSharedSnapshot(snapshot, savedState) {
  return Boolean(snapshot && (!savedState || !savedState.sharedVersion));
}

async function importSharedSnapshot(snapshot) {
  const snapshotState = stateFromSharedSnapshot(snapshot);
  const snapshotImages = Array.isArray(snapshot.images) ? snapshot.images : [];

  await clearStore("images");

  for (const image of snapshotImages) {
    const remoteUrl = image.url || image.remoteUrl || "";
    if (!image.id || !remoteUrl) continue;

    await putInStore("images", {
      id: image.id,
      roomId: image.roomId || "",
      name: image.name || "",
      type: image.type || inferImageType(remoteUrl) || "image/*",
      size: image.size || 0,
      createdAt: image.createdAt || "",
      note: image.note || "",
      tags: Array.isArray(image.tags) ? image.tags : [],
      blob: null,
      remoteUrl,
      storagePath: image.storagePath || "",
    });
  }

  await putInStore("state", snapshotState);
}

function stateFromSharedSnapshot(snapshot) {
  const snapshotState = snapshot.state || {};
  const rooms = Array.isArray(snapshotState.rooms)
    ? snapshotState.rooms.map((room) => ({
        id: room.id || makeId(),
        name: room.name || "Untitled room",
        notes: room.notes || "",
        imageIds: Array.isArray(room.imageIds) ? room.imageIds : [],
      }))
    : [];

  if (!rooms.length) rooms.push(createRoom("Kitchen"));

  return {
    id: STATE_KEY,
    rooms,
    activeRoomId: snapshotState.activeRoomId || rooms[0].id,
    activeImageId: snapshotState.activeImageId || null,
    tags: mergeUnique([...DEFAULT_TAGS, ...(Array.isArray(snapshotState.tags) ? snapshotState.tags : [])]),
    sharedVersion: snapshot.version,
  };
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
    sharedVersion: savedState.sharedVersion || "",
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

  let addedCount = 0;

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
      remoteUrl: "",
      storagePath: "",
      url: URL.createObjectURL(file),
    };

    if (isSupabaseConfigured()) {
      try {
        setDropStatus("Uploading image...");
        await uploadImageToSupabase(image);
      } catch (error) {
        console.error(error);
        if (image.url?.startsWith("blob:")) URL.revokeObjectURL(image.url);
        setDropStatus("Image upload failed. Check Supabase setup.");
        continue;
      }
    }

    imageRecords.set(image.id, image);
    room.imageIds.push(image.id);
    await putInStore("images", imageForStorage(image));
    state.activeImageId = image.id;
    addedCount += 1;
  }

  if (!addedCount) return 0;

  await saveState();
  render();
  return addedCount;
}

async function addRemoteImages(urls) {
  const room = getActiveRoom();
  if (!room) return 0;

  const imageUrls = mergeUnique(urls.filter(Boolean));
  if (!imageUrls.length) return 0;

  for (const remoteUrl of imageUrls) {
    const image = {
      id: makeId(),
      roomId: room.id,
      name: getFileNameFromUrl(remoteUrl),
      type: inferImageType(remoteUrl) || "image/*",
      size: 0,
      createdAt: new Date().toISOString(),
      note: "",
      tags: [],
      blob: null,
      remoteUrl,
      storagePath: "",
      url: remoteUrl,
    };
    imageRecords.set(image.id, image);
    room.imageIds.push(image.id);
    await putInStore("images", imageForStorage(image));
    state.activeImageId = image.id;
  }

  await saveState();
  render();
  return imageUrls.length;
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
  if (image?.blob && image.url) URL.revokeObjectURL(image.url);
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
    tab.dataset.roomId = room.id;
    tab.draggable = true;
    tab.setAttribute("aria-selected", room.id === state.activeRoomId ? "true" : "false");
    tab.addEventListener("click", () => {
      if (suppressNextTabClick) {
        suppressNextTabClick = false;
        return;
      }
      state.activeRoomId = room.id;
      state.activeImageId = room.imageIds[0] || null;
      queueStateSave();
      render();
    });
    tab.addEventListener("dragstart", (event) => {
      draggedRoomId = room.id;
      suppressNextTabClick = true;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", room.id);
      event.dataTransfer.setData("application/x-apartment-room-id", room.id);
      tab.classList.add("is-dragging");
    });
    tab.addEventListener("dragend", () => {
      clearAllRoomTabDragStates();
      finishRoomTabDrag();
    });

    roomTabs.append(tab);
  }
}

function handleRoomTabsDragOver(event) {
  if (!draggedRoomId) return;

  const dropTarget = getRoomTabDropTarget(event);
  if (!dropTarget) return;

  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "move";
  setRoomTabDropIndicator(dropTarget.tab, dropTarget.placement);
}

function handleRoomTabsDrop(event) {
  if (!draggedRoomId) return;

  const dropTarget = getRoomTabDropTarget(event);
  if (!dropTarget) return;

  event.preventDefault();
  event.stopPropagation();
  const droppedRoomId =
    event.dataTransfer.getData("application/x-apartment-room-id") ||
    event.dataTransfer.getData("text/plain") ||
    draggedRoomId;
  reorderRooms(droppedRoomId, dropTarget.tab.dataset.roomId, dropTarget.placement);
  clearAllRoomTabDragStates();
  finishRoomTabDrag();
}

function getRoomTabDropTarget(event) {
  const tabs = Array.from(roomTabs.querySelectorAll(".room-tab:not(.is-dragging)"));
  if (!tabs.length) return null;

  const isHorizontal = getComputedStyle(roomTabs).flexDirection.startsWith("row");
  const pointer = isHorizontal ? event.clientX : event.clientY;
  let lastTab = tabs[0];

  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    const start = isHorizontal ? rect.left : rect.top;
    const end = isHorizontal ? rect.right : rect.bottom;
    const midpoint = start + (end - start) / 2;
    if (pointer < midpoint) return { tab, placement: "before" };
    lastTab = tab;
  }

  return { tab: lastTab, placement: "after" };
}

function setRoomTabDropIndicator(tab, placement) {
  for (const candidate of roomTabs.querySelectorAll(".room-tab")) {
    if (candidate !== tab) clearRoomTabDropIndicator(candidate);
  }
  tab.classList.toggle("is-drop-before", placement === "before");
  tab.classList.toggle("is-drop-after", placement === "after");
}

function clearRoomTabDropIndicator(tab) {
  tab.classList.remove("is-drop-before", "is-drop-after");
}

function clearAllRoomTabDragStates() {
  for (const tab of roomTabs.querySelectorAll(".room-tab")) {
    tab.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
  }
}

function finishRoomTabDrag() {
  window.setTimeout(() => {
    draggedRoomId = "";
    suppressNextTabClick = false;
  }, 0);
}

function reorderRooms(draggedRoomId, targetRoomId, placement) {
  const fromIndex = state.rooms.findIndex((room) => room.id === draggedRoomId);
  const targetIndex = state.rooms.findIndex((room) => room.id === targetRoomId);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return;

  const [room] = state.rooms.splice(fromIndex, 1);
  let insertIndex = targetIndex;
  if (fromIndex < targetIndex) insertIndex -= 1;
  if (placement === "after") insertIndex += 1;

  state.rooms.splice(Math.max(0, Math.min(insertIndex, state.rooms.length)), 0, room);
  queueStateSave();
  renderTabs();
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
    const tags = thumb.querySelector(".thumb-tags");

    img.src = image.url;
    img.referrerPolicy = "no-referrer";
    img.alt = image.note || "Apartment inspiration image";
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
    if (!image.tags.length) tags.remove();

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

  const imageLink = document.createElement("a");
  imageLink.className = "detail-image-link";
  imageLink.href = image.url;
  imageLink.target = "_blank";
  imageLink.rel = "noopener noreferrer";
  imageLink.referrerPolicy = "no-referrer";
  imageLink.setAttribute("aria-label", "Open image full size");

  const img = document.createElement("img");
  img.src = image.url;
  img.referrerPolicy = "no-referrer";
  img.alt = image.note || "Apartment inspiration image";
  imageLink.append(img);
  imageWrap.append(imageLink);

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
  noteInput.dir = "rtl";
  noteInput.value = image.note || "";
  noteInput.placeholder = " ";
  noteInput.addEventListener("input", () => {
    image.note = noteInput.value;
    saveImageMeta(image);
    renderThumbs();
  });

  const noteInputWrap = document.createElement("span");
  noteInputWrap.className = "note-input-wrap";

  const notePlaceholder = document.createElement("span");
  notePlaceholder.className = "note-placeholder";
  notePlaceholder.textContent = "What did you like?";

  noteInputWrap.append(noteInput, notePlaceholder);
  noteField.append(noteLabel, noteInputWrap);

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
  tagInput.dir = "rtl";
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
  const save = putInStore("state", {
    id: STATE_KEY,
    rooms: state.rooms,
    activeRoomId: state.activeRoomId,
    activeImageId: state.activeImageId,
    tags: state.tags,
    sharedVersion: state.sharedVersion || "",
  });
  save.then(queueRemoteSave).catch(console.error);
  return save;
}

function saveImageMeta(image) {
  putInStore("images", imageForStorage(image)).then(queueRemoteSave).catch(console.error);
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
    remoteUrl: image.remoteUrl || "",
    storagePath: image.storagePath || "",
  };
}

function queueRemoteSave() {
  if (suppressRemoteSave || !isSupabaseConfigured() || !state) return;

  remoteSaveRequested = true;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => {
    saveRemoteBoardNow();
  }, REMOTE_SAVE_DELAY);
}

async function saveRemoteBoardNow() {
  if (suppressRemoteSave || !isSupabaseConfigured() || !state) return;

  if (remoteSaveInFlight) {
    remoteSaveRequested = true;
    return;
  }

  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = null;
  remoteSaveInFlight = true;
  remoteSaveRequested = false;
  setSyncStatus("Saving...");

  try {
    const snapshot = await buildRemoteSnapshot();
    const response = await supabaseFetch(
      `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?on_conflict=id`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({
          id: SUPABASE_BOARD_ID,
          data: snapshot,
          updated_at: snapshot.updatedAt,
        }),
      },
    );

    if (!response.ok) throw new Error(await responseText(response, "Could not save Supabase board."));

    const rows = await response.json().catch(() => []);
    remoteUpdatedAt = rows[0]?.updated_at || snapshot.updatedAt;
    setSyncStatus("Synced");
  } catch (error) {
    console.error(error);
    setSyncStatus("Save failed");
  } finally {
    remoteSaveInFlight = false;
    if (remoteSaveRequested) queueRemoteSave();
  }
}

async function buildRemoteSnapshot() {
  const images = [];

  for (const image of imageRecords.values()) {
    await ensureImageHasRemoteUrl(image);
    const url = sharedUrlForImage(image);
    if (!url) continue;

    images.push({
      id: image.id,
      roomId: image.roomId,
      name: image.name || "",
      type: image.type || inferImageType(url) || "image/*",
      size: image.size || 0,
      createdAt: image.createdAt || "",
      note: image.note || "",
      tags: Array.isArray(image.tags) ? image.tags : [],
      url,
      source: image.storagePath ? "supabase-storage" : "remote",
      storagePath: image.storagePath || "",
      originalUrl: image.remoteUrl || "",
    });
  }

  return {
    id: "apartment-board-supabase",
    version: "supabase-v1",
    updatedAt: new Date().toISOString(),
    state: {
      id: STATE_KEY,
      rooms: state.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        notes: room.notes || "",
        imageIds: room.imageIds.filter((id) => imageRecords.has(id)),
      })),
      activeRoomId: state.activeRoomId,
      activeImageId: state.activeImageId,
      tags: state.tags,
    },
    images,
  };
}

async function ensureImageHasRemoteUrl(image) {
  if (!image.blob || image.remoteUrl) return;
  await uploadImageToSupabase(image);
  await putInStore("images", imageForStorage(image));
}

async function uploadImageToSupabase(image) {
  if (!image.blob) return image.remoteUrl || "";

  const storagePath = `${image.id}.${extensionForImage(image)}`;
  const response = await supabaseFetch(
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${storagePath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": image.blob.type || image.type || "application/octet-stream",
        "x-upsert": "true",
      },
      body: image.blob,
    },
  );

  if (!response.ok) throw new Error(await responseText(response, "Could not upload image to Supabase."));

  const objectUrl = image.url?.startsWith("blob:") ? image.url : "";
  image.remoteUrl = publicStorageUrl(storagePath);
  image.storagePath = storagePath;
  image.blob = null;
  image.url = image.remoteUrl;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  return image.remoteUrl;
}

function sharedUrlForImage(image) {
  const url = image.remoteUrl || image.url || "";
  if (!url || url.startsWith("blob:")) return "";
  if (url.startsWith("./") || url.startsWith("../") || url.startsWith("/")) {
    return new URL(url, PUBLIC_SITE_URL).href;
  }
  return url;
}

function publicStorageUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${storagePath}`;
}

function extensionForImage(image) {
  const type = image.blob?.type || image.type || "";
  const types = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };
  if (types[type]) return types[type];
  const extension = image.name?.split(".").pop()?.toLowerCase();
  return extension && extension.length <= 5 ? extension : "img";
}

function supabaseFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(options.headers || {}),
    },
  });
}

async function responseText(response, fallback) {
  const text = await response.text().catch(() => "");
  return `${fallback} (${response.status})${text ? `: ${text}` : ""}`;
}

function setSyncStatus(message) {
  if (!syncStatus) return;
  syncStatus.textContent = message;
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

function clearStore(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).clear();
    request.onsuccess = () => resolve();
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
