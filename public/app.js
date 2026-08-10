const form = document.querySelector("#uploadForm");
const input = document.querySelector("#photos");
const dropzone = document.querySelector(".dropzone label");
const submitButton = form.querySelector("button");
const selectedPhotos = document.querySelector("#selectedPhotos");
const statusText = document.querySelector("#status");
const links = document.querySelector("#links");

let selectedFiles = [];
let selectedUrls = [];
let createdLinks = [];

function setStatus(text, kind = "") {
  statusText.textContent = text;
  statusText.className = `status ${kind}`.trim();
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setSubmitState() {
  submitButton.disabled = selectedFiles.length === 0;
}

function clearSelectedPreviews() {
  selectedUrls.forEach((url) => URL.revokeObjectURL(url));
  selectedUrls = [];
  selectedPhotos.replaceChildren();
  selectedPhotos.hidden = true;
}

function syncInputFiles() {
  const data = new DataTransfer();
  selectedFiles.forEach((file) => data.items.add(file));
  input.files = data.files;
  setSubmitState();
}

function renderSelectedPreviews() {
  clearSelectedPreviews();

  if (!selectedFiles.length) {
    setStatus("");
    return;
  }

  const header = document.createElement("div");
  header.className = "selected-header";

  const title = document.createElement("p");
  title.className = "selected-title";
  title.textContent = `Готово к загрузке: ${selectedFiles.length}`;

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "ghost-button";
  clear.textContent = "Очистить";
  clear.addEventListener("click", () => {
    selectedFiles = [];
    syncInputFiles();
    clearSelectedPreviews();
    setStatus("");
  });

  header.append(title, clear);

  const grid = document.createElement("div");
  grid.className = "selected-grid";

  selectedFiles.forEach((file, index) => {
    const card = document.createElement("article");
    card.className = "selected-card";

    const previewUrl = URL.createObjectURL(file);
    selectedUrls.push(previewUrl);

    const img = document.createElement("img");
    img.src = previewUrl;
    img.alt = file.name;

    const meta = document.createElement("div");
    meta.className = "selected-meta";

    const name = document.createElement("span");
    name.textContent = file.name;

    const size = document.createElement("small");
    size.textContent = formatSize(file.size);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-button";
    remove.textContent = "Удалить";
    remove.addEventListener("click", () => {
      selectedFiles.splice(index, 1);
      syncInputFiles();
      renderSelectedPreviews();
    });

    meta.append(name, size, remove);
    card.append(img, meta);
    grid.append(card);
  });

  selectedPhotos.append(header, grid);
  selectedPhotos.hidden = false;
  setStatus("Нажми «Загрузить», и ссылки появятся снизу.");
}

function setFiles(files) {
  selectedFiles = [...files].filter((file) => file.type.startsWith("image/"));
  syncInputFiles();
  renderSelectedPreviews();
}

function addLink(photo) {
  createdLinks.unshift(photo.url);

  const row = document.createElement("article");
  row.className = "link-row";

  const preview = document.createElement("img");
  preview.src = photo.imageUrl;
  preview.alt = "";

  const url = document.createElement("input");
  url.value = photo.url;
  url.readOnly = true;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Скопировать";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(photo.url);
    copy.textContent = "Скопировано";
    setTimeout(() => {
      copy.textContent = "Скопировать";
    }, 1200);
  });

  row.append(preview, url, copy);
  links.prepend(row);
}

function renderCopyAllButton() {
  let copyAll = document.querySelector("#copyAllLinks");
  if (!createdLinks.length) {
    copyAll?.remove();
    return;
  }

  if (!copyAll) {
    copyAll = document.createElement("button");
    copyAll.id = "copyAllLinks";
    copyAll.type = "button";
    copyAll.className = "copy-all";
    copyAll.textContent = "Скопировать все ссылки";
    copyAll.addEventListener("click", async () => {
      await navigator.clipboard.writeText(createdLinks.join("\n"));
      copyAll.textContent = "Все ссылки скопированы";
      setTimeout(() => {
        copyAll.textContent = "Скопировать все ссылки";
      }, 1400);
    });
    links.before(copyAll);
  }
}

input.addEventListener("change", () => {
  setFiles(input.files);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
});

dropzone.addEventListener("drop", (event) => {
  setFiles(event.dataTransfer.files);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!selectedFiles.length) {
    setStatus("Выбери хотя бы одно фото.", "error");
    return;
  }

  const data = new FormData();
  selectedFiles.forEach((file) => data.append("photos", file));

  submitButton.disabled = true;
  setStatus("Загружаю...");

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: data
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.error || "Ошибка загрузки.");
    result.photos.forEach(addLink);
    renderCopyAllButton();
    setStatus(`Готово: ссылок создано ${result.photos.length}. Можно добавить ещё фото.`, "success");
    selectedFiles = [];
    syncInputFiles();
    clearSelectedPreviews();
  } catch (error) {
    setStatus(error.message, "error");
    setSubmitState();
  }
});

setSubmitState();
