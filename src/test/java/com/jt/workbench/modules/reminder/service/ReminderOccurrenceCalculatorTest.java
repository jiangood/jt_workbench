package com.jt.workbench.modules.reminder.service;

import com.jt.workbench.modules.reminder.entity.Reminder;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ReminderOccurrenceCalculatorTest {

    @Test
    void monthlyReminderClampsToLastDayOfShortMonth() {
        Reminder reminder = reminder(LocalDate.of(2026, 1, 31), "monthly");

        assertTrue(ReminderOccurrenceCalculator.matches(reminder, LocalDate.of(2026, 2, 28)));
        assertTrue(ReminderOccurrenceCalculator.matches(reminder, LocalDate.of(2026, 4, 30)));
        assertTrue(ReminderOccurrenceCalculator.matches(reminder, LocalDate.of(2026, 3, 31)));

        assertEquals(LocalDate.of(2026, 2, 28),
                ReminderOccurrenceCalculator.nextOccurrence(reminder, LocalDate.of(2026, 2, 1)));
    }

    @Test
    void yearlyLeapDayFallsBackToLastDayOfFebruary() {
        Reminder reminder = reminder(LocalDate.of(2024, 2, 29), "yearly");

        assertTrue(ReminderOccurrenceCalculator.matches(reminder, LocalDate.of(2025, 2, 28)));
        assertTrue(ReminderOccurrenceCalculator.matches(reminder, LocalDate.of(2028, 2, 29)));

        assertEquals(LocalDate.of(2027, 2, 28),
                ReminderOccurrenceCalculator.nextOccurrence(reminder, LocalDate.of(2027, 1, 1)));
    }

    @Test
    void weeklyAndSingleReminders() {
        Reminder weekly = reminder(LocalDate.of(2026, 11, 2), "weekly");
        assertTrue(ReminderOccurrenceCalculator.matches(weekly, LocalDate.of(2026, 11, 16)));
        assertEquals(LocalDate.of(2026, 11, 23),
                ReminderOccurrenceCalculator.nextOccurrence(weekly, LocalDate.of(2026, 11, 17)));

        Reminder single = reminder(LocalDate.of(2026, 11, 20), "");
        assertNull(ReminderOccurrenceCalculator.nextOccurrence(single, LocalDate.of(2026, 11, 21)));
    }

    @Test
    void advanceOffsetsReturnTheOccurrenceBeingReminded() {
        Reminder reminder = reminder(LocalDate.of(2026, 12, 25), "");
        List<Integer> offsets = List.of(30, 7, 0);

        assertEquals(LocalDate.of(2026, 12, 25),
                ReminderOccurrenceCalculator.dueOccurrence(reminder, LocalDate.of(2026, 11, 25), offsets));
        assertEquals(LocalDate.of(2026, 12, 25),
                ReminderOccurrenceCalculator.dueOccurrence(reminder, LocalDate.of(2026, 12, 18), offsets));
        assertEquals(LocalDate.of(2026, 12, 25),
                ReminderOccurrenceCalculator.dueOccurrence(reminder, LocalDate.of(2026, 12, 25), offsets));
        assertNull(ReminderOccurrenceCalculator.dueOccurrence(reminder, LocalDate.of(2026, 12, 1), offsets));
    }

    @Test
    void lunarYearlyReminderUsesLunarMonthAndDay() {
        Reminder reminder = new Reminder();
        reminder.setLunar(true);
        reminder.setType("yearly");
        reminder.setLunarMonth(1);
        reminder.setLunarDay(1);

        assertEquals(LocalDate.of(2026, 2, 17),
                ReminderOccurrenceCalculator.nextOccurrence(reminder, LocalDate.of(2026, 2, 10)));
        assertTrue(ReminderOccurrenceCalculator.matches(reminder, LocalDate.of(2026, 2, 17)));
    }

    @Test
    void lunarLeapMonthOnlyMatchesLeapMonth() {
        Reminder reminder = new Reminder();
        reminder.setLunar(true);
        reminder.setType("yearly");
        reminder.setLunarMonth(6);
        reminder.setLunarDay(1);
        reminder.setLunarLeap(true);

        assertEquals(LocalDate.of(2025, 7, 25),
                ReminderOccurrenceCalculator.nextOccurrence(reminder, LocalDate.of(2025, 1, 1)));
        assertTrue(ReminderOccurrenceCalculator.matches(reminder, LocalDate.of(2025, 7, 25)));
    }

    @Test
    void offsetsParsingSupportsLegacyFields() {
        Reminder reminder = new Reminder();
        reminder.setRemindOffsetsJson("30, 7,0,abc,-1");
        assertEquals(List.of(30, 7, 0), ReminderOccurrenceCalculator.offsetsOf(reminder));

        Reminder legacy = new Reminder();
        legacy.setRemindOffsets(3);
        assertEquals(List.of(3), ReminderOccurrenceCalculator.offsetsOf(legacy));

        Reminder empty = new Reminder();
        assertEquals(List.of(0), ReminderOccurrenceCalculator.offsetsOf(empty));
    }

    private static Reminder reminder(LocalDate eventDate, String type) {
        Reminder reminder = new Reminder();
        reminder.setEventDate(eventDate);
        reminder.setType(type);
        reminder.setLunar(false);
        return reminder;
    }
}
