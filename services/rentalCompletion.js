import { getCollections } from "../db.js";
import { sendMail } from "./mailer.js";

// Statuses that can still move to Completed
const OPEN_STATUSES = ["Pending", "Confirmed", "Active"];

const escapeHtml = (v = "") =>
  String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function emailBody(title, intro, rental) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto">
      <h2 style="color:#111">${title}</h2>
      <p>${intro}</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td><b>Equipment</b></td><td>${escapeHtml(rental.equipmentName)}</td></tr>
        <tr><td><b>Quantity</b></td><td>${escapeHtml(rental.quantity)}</td></tr>
        <tr><td><b>Rental period</b></td><td>${escapeHtml(rental.startDate)} to ${escapeHtml(rental.endDate)}</td></tr>
        <tr><td><b>Total amount</b></td><td>$${escapeHtml(rental.totalPrice)}</td></tr>
      </table>
      <p style="color:#666;font-size:12px">Apex Rentals</p>
    </div>`;
}

async function sendCompletionEmails(rental) {
  await Promise.all([
    sendMail({
      to: rental.customerEmail,
      subject: `Your rental is completed: ${rental.equipmentName}`,
      html: emailBody(
        "Rental completed",
        `Hi ${escapeHtml(rental.customerName || "there")}, your rental has been completed. Thank you for renting with Apex Rentals.`,
        rental,
      ),
    }),
    sendMail({
      to: rental.ownerEmail,
      subject: `Rental completed: ${rental.equipmentName}`,
      html: emailBody(
        "A rental on your equipment is completed",
        `The rental by ${escapeHtml(rental.customerName || rental.customerEmail)} has ended and your stock has been restored.`,
        rental,
      ),
    }),
  ]);
}

// Moves one rental to Completed exactly once, restores stock, sends emails.
// Returns the updated rental, or null if it was already completed/cancelled.
export async function markRentalCompleted(rentalId) {
  const { rentals, equipment } = await getCollections();
  const now = new Date();

  // The status filter makes this atomic, so two callers can never both complete it
  const rental = await rentals.findOneAndUpdate(
    { _id: rentalId, bookingStatus: { $in: OPEN_STATUSES } },
    {
      $set: {
        bookingStatus: "Completed",
        status: "Completed",
        completedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!rental) return null;

  // Give the units back, never going above totalQuantity
  const qty = Number(rental.quantity) || 0;
  if (rental.equipmentId && qty > 0) {
    await equipment.updateOne({ _id: rental.equipmentId }, [
      {
        $set: {
          availableQuantity: {
            $min: [
              { $add: [{ $ifNull: ["$availableQuantity", 0] }, qty] },
              { $ifNull: ["$totalQuantity", 999999] },
            ],
          },
          updatedAt: now,
        },
      },
    ]);
  }

  await sendCompletionEmails(rental);
  return rental;
}

// Completes every open rental whose end date has passed
export async function completeExpiredRentals() {
  const { rentals } = await getCollections();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC

  const expired = await rentals
    .find({
      bookingStatus: { $in: OPEN_STATUSES },
      endDate: { $gt: "", $lt: today },
    })
    .project({ _id: 1 })
    .toArray();

  let completed = 0;
  for (const { _id } of expired) {
    try {
      if (await markRentalCompleted(_id)) completed += 1;
    } catch (err) {
      console.error(`Failed to complete rental ${_id}:`, err.message);
    }
  }

  return { found: expired.length, completed };
}
