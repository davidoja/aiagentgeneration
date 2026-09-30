// Copy this file to the theme asset assets/distributor-form-supabase.js.
// Load it from sections/sultan-distributor-form.liquid after the form and
// before {% schema %}. Do not change the form fields or prevent the submit:
// Shopify still emails the store contact address.
(function () {
  var ENDPOINT = "https://wsqxlbdujiqthnihfaww.supabase.co/functions/v1/wholesale-inquiry";
  var form = document.getElementById("DistributorForm");
  if (!form || form.getAttribute("data-supabase-bound") === "1") {
    return;
  }
  form.setAttribute("data-supabase-bound", "1");

  var honey = document.createElement("input");
  honey.type = "text";
  honey.name = "company_website";
  honey.tabIndex = -1;
  honey.autocomplete = "off";
  honey.setAttribute("aria-hidden", "true");
  honey.style.position = "absolute";
  honey.style.left = "-9999px";
  honey.style.height = "1px";
  honey.style.width = "1px";
  form.appendChild(honey);

  form.addEventListener("submit", function () {
    var contact = {};
    var fields = form.querySelectorAll("[name]");
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var name = field.getAttribute("name") || "";
      var match = name.match(/^contact\[(.+)\]$/);
      if (!match) {
        continue;
      }
      contact[match[1]] = field.value || "";
    }
    fetch(ENDPOINT, {
      method: "POST",
      mode: "cors",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contact: contact,
        company_website: honey.value || ""
      })
    }).catch(function () {});
  });
})();
