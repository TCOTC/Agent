(function () {
  var btn = document.querySelector("[data-menu-toggle]");
  var sidebar = document.querySelector(".sidebar");
  if (!btn || !sidebar) {
    return;
  }
  btn.addEventListener("click", function () {
    sidebar.classList.toggle("is-collapsed");
  });
})();
