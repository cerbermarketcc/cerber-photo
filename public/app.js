const form = document.querySelector("#uploadForm");
const input = document.querySelector("#photos");
const selectedPhotos = document.querySelector("#selectedPhotos");
const statusText = document.querySelector("#status");
const links = document.querySelector("#links");
let selectedUrls = [];

function setStatus(text, kind = "") {
  statusText.textContent = text;
  statusText.className = `status ${kind}`.trim();
}

function addLink(photo) {
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

function clearSelectedPreviews() {
  selectedUrls.forEach((url) => URL.revokeObjectURL(url));
  selectedUrls = [];
  selectedPhotos.replaceChildren();
  selectedPhotos.hidden = true;
}

function renderSelectedPreviews(files) {
  clearSelectedPreviews();

  if (!files.length) return;

  const title = document.createElement("p");
  title.className = "selected-title";
  title.textContent = `Выбрано фото: ${files.length}`;
  selectedPhotos.append(title);

  const grid = document.createElement("div");
  grid.className = "selected-grid";

  for (const file of files) {
    const card = document.createElement("article");
    card.className = "selected-card";

    const previewUrl = URL.createObjectURL(file);
    selectedUrls.push(previewUrl);

    const img = document.createElement("img");
    img.src = previewUrl;
    img.alt = file.name;

    const name = document.createElement("span");
    name.textContent = file.name;

    card.append(img, name);
    grid.append(card);
  }

  selectedPhotos.append(grid);
  selectedPhotos.hidden = false;
  setStatus("Фото выбраны. Нажми «Загрузить», и ссылки появятся снизу.");
}

input.addEventListener("change", () => {
  renderSelectedPreviews([...input.files]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!input.files.length) {
    setStatus("Выбери хотя бы одно фото.", "error");
    return;
  }

  const data = new FormData();
  for (const file of input.files) data.append("photos", file);

  form.querySelector("button").disabled = true;
  setStatus("Загружаю...");

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: data
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.error || "Ошибка загрузки.");
    result.photos.forEach(addLink);
    setStatus(`Готово: ссылок создано ${result.photos.length}. Можно добавить ещё фото.`, "success");
    input.value = "";
    clearSelectedPreviews();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    form.querySelector("button").disabled = false;
  }
});
