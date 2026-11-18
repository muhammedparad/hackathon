// Per-user reminders, stored in Firestore (collection "reminders", readable and writable only by the owner).
import { queryOptions } from "@tanstack/react-query";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import { getFirestoreDb } from "@/lib/firebase/db";
import { authClient } from "@/lib/auth";
import type { Reminder } from "@/lib/notify";

export const remindersQuery = queryOptions({
  queryKey: ["reminders"],
  queryFn: async (): Promise<Reminder[]> => {
    const db = getFirestoreDb();
    const user = await authClient.getUser();
    if (!db || !user) return [];
    const snap = await getDocs(query(collection(db, "reminders"), where("user_id", "==", user.id)));
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<Reminder, "id">) }))
      .sort((a, b) => a.time.localeCompare(b.time));
  },
});

export async function createReminder(input: {
  title: string;
  time: string;
  repeat: "daily" | "once";
  date: string | null;
}): Promise<void> {
  const db = getFirestoreDb();
  const user = await authClient.getUser();
  if (!db || !user) throw new Error("Not signed in");
  await addDoc(collection(db, "reminders"), {
    user_id: user.id,
    title: input.title.trim(),
    time: input.time,
    repeat: input.repeat,
    date: input.repeat === "once" ? input.date : null,
    enabled: true,
    last_fired_date: null,
    created_at: new Date().toISOString(),
  });
}

export async function updateReminder(
  id: string,
  patch: Partial<Pick<Reminder, "enabled" | "last_fired_date">>,
): Promise<void> {
  const db = getFirestoreDb();
  if (!db) throw new Error("Firestore is not configured");
  await updateDoc(doc(db, "reminders", id), patch);
}

export async function deleteReminder(id: string): Promise<void> {
  const db = getFirestoreDb();
  if (!db) throw new Error("Firestore is not configured");
  await deleteDoc(doc(db, "reminders", id));
}
