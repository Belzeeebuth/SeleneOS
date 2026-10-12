// Example content created on the very first launch, in the user's language. Every seeded task / list
// carries `seed: true` so "Remove examples" can take them away again.
import { addDays } from './dates.js';

const TEXT = {
  en: {
    list: 'Groceries',
    welcome: 'Welcome to Tasks. Tick the circle to complete a task',
    star: 'Star a task to mark it as important',
    myday: 'Plan your day: add tasks to My Day',
    steps: 'Break big tasks into steps',
    stepsList: ['Open the task', 'Add a step', 'Tick it off'],
    due: 'Give a task a due date and a reminder',
    note: 'Notes live in the details pane. Select a task to open it.',
    groceries: ['Milk', 'Bread', 'Coffee beans'],
  },
  fr: {
    list: 'Courses',
    welcome: 'Bienvenue dans Tâches. Cochez le cercle pour terminer une tâche',
    star: 'Ajoutez une étoile pour marquer une tâche comme importante',
    myday: 'Planifiez votre journée : ajoutez des tâches à Ma journée',
    steps: 'Divisez les grandes tâches en étapes',
    stepsList: ['Ouvrir la tâche', 'Ajouter une étape', 'La cocher'],
    due: 'Donnez une échéance et un rappel à une tâche',
    note: 'Les notes se trouvent dans le volet de détails. Sélectionnez une tâche pour l’ouvrir.',
    groceries: ['Lait', 'Pain', 'Café en grains'],
  },
};

export function seed(store, lang = 'en') {
  const s = TEXT[lang] || TEXT.en;
  const today = store.today();
  const add = (f) => store.addTask({ ...f, seed: true }, { top: false });
  add({ title: s.welcome, myDay: true });
  add({ title: s.star, important: true });
  add({ title: s.myday, myDay: true });
  add({ title: s.steps, steps: s.stepsList.map((title, i) => ({ title, done: i === 0 })) });
  add({ title: s.due, due: addDays(today, 1), note: s.note });
  const list = store.addList(s.list, { theme: { color: 'green', bg: null } });
  list.seed = true;
  for (const title of s.groceries) add({ title, listId: list.id });
}
