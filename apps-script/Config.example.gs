/**
 * Copy this file to a new script file named "Config" in the Apps Script editor
 * and fill in the real values. Do NOT commit the filled-in copy: the GitHub
 * repository is public, and this file holds the family's email addresses.
 */
const CONFIG = {
  // From Google Cloud console > APIs & Services > Credentials (see SETUP.md, step 2).
  CLIENT_ID: 'PASTE-CLIENT-ID.apps.googleusercontent.com',

  // First name, used in greetings and email drafts.
  STUDENT_NAME: 'Student',

  // Who may sign in. The student gets the student app, parents get the parent view.
  STUDENT_EMAIL: 'student@example.com',
  PARENT_EMAILS: ['parent1@example.com', 'parent2@example.com'],

  TIMEZONE: 'America/New_York',

  // Calendar names exactly as they appear in Google Calendar (the owner must be subscribed).
  // The number in parentheses is the class period; the app reads it from the name.
  CLASS_CALENDARS: {
    Chem: 'CHEMISTRY (1) Assignments',
    Photo: 'PHOTOGRAPHY (2) Assignments',
    Alg: 'ALGEBRA (3) Assignments',
    Hist: 'HISTORY (4) Assignments',
    Span: 'SPANISH (5) Assignments',
    Eng: 'ENGLISH (7) Assignments',
  },
  // Only events whose title starts with "Day <number>" are read from this calendar.
  SCHOOL_CALENDAR: 'School Events',
  // Events here make an afternoon "short" (basketball, family plans).
  BUSY_CALENDARS: ['Sports', 'Family'],

  // Created by setup(). Shared with the student.
  PLAN_CALENDAR: "Hudson's Plan",         // teacher visits and plan blocks, no alerts
  REMINDER_CALENDAR: "Hudson's Reminders", // the two daily alerts

  // Reminder times (24h, local).
  MORNING_REMINDER: '07:00',
  AFTERNOON_REMINDER: '15:25',

  // Teachers, used in visit titles and email drafts.
  TEACHERS: { Chem: 'Mr. Chem', Photo: 'Mr. Photo', Alg: 'Mr. Algebra', Hist: 'Mr. History', Span: 'Mrs. Spanish', Eng: 'Ms. English' },

  // A Photography class day when a sketchbook is due. The app counts every other Photo class from here.
  SKETCHBOOK_START: '2026-11-16',

  // Membean: 4 sessions of 10 minutes in each 2-week cycle.
  MEMBEAN_CYCLE_START: '2026-11-16',
};
