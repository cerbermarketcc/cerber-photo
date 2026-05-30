const form = document.querySelector("#uploadForm");
const input = document.querySelector("#photos");
const statusText = document.querySelector("#status");
const links = document.querySelector("#links");

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
    setStatus(`Готово: ссылок создано ${result.photos.length}.`, "success");
    input.value = "";
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    form.querySelector("button").disabled = false;
  }
});
