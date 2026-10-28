"use strict";

// Race a fallback only when a visible cover stalls; ordinary fast loads use one request.
window.MoeCovers = (() => {
  const HEDGE_MS = 1400;
  const WATCHDOG_MS = 8000;
  const jobs = new Map();
  const winners = new Map();
  const slowHosts = new Map();
  let observer;

  function candidates(values) {
    const urls = [...new Set(values.filter(Boolean))];
    const winner = winners.get(urls[0]);
    const ready = urls.filter(url => {
      try { return (slowHosts.get(new URL(url).host) || 0) < Date.now(); }
      catch { return false; }
    });
    if (winner && urls.includes(winner)) return [winner, ...urls.filter(url => url !== winner)];
    return ready.length ? [...ready, ...urls.filter(url => !ready.includes(url))] : urls;
  }

  function release(job) {
    clearTimeout(job.timer);
    clearTimeout(job.watchdog);
    job.image.removeEventListener("load", job.loaded);
    job.image.removeEventListener("error", job.failed);
    if (job.probe) {
      job.probe.onload = job.probe.onerror = null;
      job.probe.removeAttribute("src");
    }
    jobs.delete(job.image);
  }

  function finish(job, url) {
    if (!jobs.has(job.image)) return;
    const fallbackWon = url !== job.primary;
    if (fallbackWon) {
      try { slowHosts.set(new URL(job.primary).host, Date.now() + 60_000); } catch {}
    }
    winners.set(job.key, url);
    if (winners.size > 256) winners.delete(winners.keys().next().value);
    release(job);
    if (job.image.isConnected && job.image.getAttribute("src") !== url) job.image.src = url;
  }

  function retryButton(job) {
    const image = job.image;
    release(job);
    if (!image.isConnected) return;
    image.hidden = true;
    if (image.parentElement.querySelector(".cover-retry")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cover-retry";
    button.textContent = "Tải lại ảnh";
    button.setAttribute("aria-label", "Tải lại " + image.alt);
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      button.remove();
      image.hidden = false;
      delete image.dataset.coverBound;
      winners.delete(job.key);
      const urls = candidates(job.allUrls);
      image.src = urls.shift();
      image.dataset.fallback = JSON.stringify(urls);
      observe(image.parentElement);
    };
    image.parentElement.append(button);
  }

  function fallback(job) {
    if (!jobs.has(job.image)) return;
    if (!job.image.isConnected) { release(job); return; }
    if (job.image.complete && job.image.naturalWidth > 0) { finish(job, job.image.currentSrc || job.image.src); return; }
    if (job.probe) return;
    const url = job.urls.shift();
    if (!url) { if (job.primaryFailed) retryButton(job); return; }
    const probe = new Image();
    job.probe = probe;
    probe.decoding = "async";
    probe.fetchPriority = job.image.fetchPriority || "auto";
    probe.referrerPolicy = "no-referrer";
    probe.onload = () => finish(job, url);
    probe.onerror = () => {
      if (!jobs.has(job.image)) return;
      probe.onload = probe.onerror = null;
      job.probe = null;
      fallback(job);
    };
    probe.src = url;
  }

  function start(image) {
    const job = jobs.get(image);
    if (!job || job.started) return;
    job.started = true;
    if (image.complete && image.naturalWidth > 0) { finish(job, image.currentSrc || image.src); return; }
    job.timer = setTimeout(() => fallback(job), HEDGE_MS);
    // Do not leave a cover waiting indefinitely when both hosts stop responding.
    job.watchdog = setTimeout(() => retryButton(job), WATCHDOG_MS);
    if (job.primaryFailed) fallback(job);
  }

  function observe(root) {
    const images = root.matches?.("img[data-cover]") ? [root] : [...root.querySelectorAll("img[data-cover]")];
    for (const image of images) {
      if (image.dataset.coverBound) continue;
      image.dataset.coverBound = "1";
      const urls = JSON.parse(image.dataset.fallback || "[]");
      const primary = image.getAttribute("src");
      const job = {image, urls, allUrls:[primary, ...urls], primary, key: image.dataset.coverPrimary || primary, started: false};
      job.loaded = () => finish(job, image.currentSrc || image.src);
      job.failed = () => { job.primaryFailed = true; start(image); fallback(job); };
      jobs.set(image, job);
      image.addEventListener("load", job.loaded);
      image.addEventListener("error", job.failed);
      if (image.complete && image.naturalWidth > 0) finish(job, image.currentSrc || image.src);
      else if (image.loading === "eager" || !observer) start(image);
      else observer.observe(image);
    }
  }

  if ("IntersectionObserver" in window) observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      start(entry.target);
    }
  }, {rootMargin: "300px 0px"});

  function reset() {
    observer?.disconnect();
    for (const job of [...jobs.values()]) release(job);
  }

  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) observe(node);
    for (const job of [...jobs.values()]) if (!job.image.isConnected) release(job);
  }).observe(document.querySelector("#main"), {childList: true, subtree: true});

  return {candidates, observe, reset};
})();
