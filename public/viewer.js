const photoId = document.body.dataset.photoId || "";
const photo = document.querySelector("#privatePhoto");
const statusText = document.querySelector("#viewerStatus");

function setUnavailable() {
  photo.hidden = true;
  statusText.hidden = false;
  statusText.textContent = "Фото недоступно или приватная ссылка неверна.";
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
      if (!response.ok) return setUnavailable();

      history.replaceState(null, "", `/p/${photoId}`);
    } catch {
      return setUnavailable();
    }
  }

  photo.addEventListener("load", () => {
    statusText.hidden = true;
    photo.hidden = false;
  }, { once: true });
  photo.addEventListener("error", setUnavailable, { once: true });
  photo.src = `/image/${photoId}`;
}

unlockPhoto();
