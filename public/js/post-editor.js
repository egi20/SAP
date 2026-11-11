/*
 * "Write a post": turns the body <textarea> into a Quill editor, so the author writes in
 * the formatted view, as on dynamicshub.net.
 *
 * The textarea stays the field the form submits. Without scripting, or if Quill fails to
 * load, it is simply the plain HTML box it always was. With Quill, it is hidden and filled
 * from the editor on submit; the "HTML" button swaps back to it for anybody (or any tool)
 * that wants to paste or edit the markup directly, and swapping back loads the box into
 * the editor.
 *
 * The toolbar offers only what the server keeps (utils/sanitize.js, sanitizePostBody):
 * offering a format the sanitizer strips would be a button that silently does nothing.
 */
(function () {
  'use strict';

  var textarea = document.getElementById('body');
  var mount = document.getElementById('body-editor');
  var toggle = document.getElementById('body-mode-toggle');
  if (!textarea || !mount || typeof window.Quill !== 'function') return;

  var form = textarea.form;
  var quill = new window.Quill(mount, {
    theme: 'snow',
    placeholder: 'Write your post…',
    modules: {
      toolbar: [
        [{ header: [3, 4, false] }],
        ['bold', 'italic', 'underline', 'strike', 'code'],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['blockquote', 'code-block'],
        ['link', 'image'],
        ['clean']
      ]
    },
    formats: [
      'header', 'bold', 'italic', 'underline', 'strike', 'code',
      'list', 'blockquote', 'code-block', 'link', 'image'
    ]
  });

  function loadFromTextarea() {
    quill.setContents([]);
    if (textarea.value.trim()) quill.clipboard.dangerouslyPasteHTML(0, textarea.value, 'silent');
  }

  function editorHtml() {
    if (quill.getLength() <= 1 && !quill.root.querySelector('img')) return '';
    // Quill 2.0.x writes every space as &nbsp; in its semantic HTML, which stops lines
    // wrapping on the published page. Plain spaces are what the author typed.
    // Quill also keeps an empty last line, which would publish as a blank paragraph.
    return quill
      .getSemanticHTML()
      .replace(/&nbsp;/g, ' ')
      .replace(/(?:<p>(?:<br>)?<\/p>)+$/, '');
  }

  var htmlMode = false;
  var wrapper = mount.parentNode;

  function setHtmlMode(on) {
    if (on === htmlMode) return;
    if (on) {
      textarea.value = editorHtml();
    } else {
      loadFromTextarea();
    }
    htmlMode = on;
    wrapper.hidden = on;
    textarea.hidden = !on;
    if (toggle) {
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      toggle.textContent = on ? 'Formatted view' : 'Edit HTML';
    }
    (on ? textarea : quill).focus();
  }

  loadFromTextarea();
  // The browser cannot validate a hidden field; the server's own check still runs.
  textarea.removeAttribute('required');
  textarea.removeAttribute('minlength');
  textarea.hidden = true;
  wrapper.hidden = false;
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener('click', function () {
      setHtmlMode(!htmlMode);
    });
  }

  form.addEventListener('submit', function () {
    if (!htmlMode) textarea.value = editorHtml();
  });

  // For tools that stage a draft: set the body as HTML, whichever view is showing.
  window.postEditor = {
    quill: quill,
    setHtml: function (html) {
      textarea.value = String(html || '');
      if (!htmlMode) loadFromTextarea();
    },
    getHtml: function () {
      return htmlMode ? textarea.value : editorHtml();
    }
  };
})();
