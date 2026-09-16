const photoId = document.body.dataset.photoId || "";
const photo = document.querySelector("#privatePhoto");
const statusText = document.querySelector("#viewerStatus");

function setUnavailable(message = "Фото недоступно или приватная ссылка неверна.") {
  photo.hidden = true;
  statusText.hidden = false;
  statusText.textContent = message;
}

async function unlockPhoto() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const key = fragment.get("key") || "";

  if (key) {
    try {
      const response = await fetch(`/api/photos/${photoId}/session`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key })
      });
      if (!response.ok) {
        if (response.status === 429) return setUnavailable("Слишком много попыток. Откройте эту же ссылку немного позже.");
        if (response.status >= 500) return setUnavailable("Хранилище временно недоступно. Попробуйте открыть эту же ссылку позже.");
        return setUnavailable();
      }

      // Keep the fragment so copying or reopening the URL retains access.
    } catch {
      return setUnavailable("Не удалось загрузить фото. Проверьте соединение и откройте эту же ссылку снова.");
    }
  }

  photo.addEventListener("load", () => {
    statusText.hidden = true;
    photo.hidden = false;
  }, { once: true });
  photo.addEventListener("error", () => setUnavailable(), { once: true });
  photo.src = `/image/${photoId}`;
}

unlockPhoto();
