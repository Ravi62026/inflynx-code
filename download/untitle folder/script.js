const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav-links');
menuToggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', open);
});

document.querySelectorAll('.nav-links a').forEach(link => link.addEventListener('click', () => nav.classList.remove('open')));

document.querySelectorAll('.filters button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelector('.filters button.active').classList.remove('active');
    button.classList.add('active');
    const category = button.dataset.filter;
    document.querySelectorAll('.project').forEach(project => {
      project.style.display = category === 'all' || project.dataset.category === category ? '' : 'none';
    });
  });
});

const form = document.querySelector('#contact-form');
const success = document.querySelector('.form-success');
form.addEventListener('submit', event => {
  event.preventDefault();
  [...form.children].forEach(child => { if (!child.classList.contains('form-success')) child.style.display = 'none'; });
  success.classList.add('show');
});
