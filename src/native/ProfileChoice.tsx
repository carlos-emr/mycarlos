import type { PatientProfile } from "../vault";

/**
 * One button per patient profile, instead of a dropdown (#67). With only one
 * profile there is nothing to choose, so it shows nothing.
 */
export function ProfileChoice({
  profiles,
  profileId,
  onChoose,
  className = "",
}: {
  profiles: PatientProfile[];
  profileId: string;
  onChoose: (profileId: string) => void;
  className?: string;
}) {
  if (profiles.length < 2) return null;
  return (
    <div
      className={`native-profile-choice ${className}`.trim()}
      role="group"
      aria-label="Patient"
    >
      <span className="native-profile-choice-label" aria-hidden="true">
        Patient
      </span>
      {profiles.map((profile) => (
        <button
          key={profile.id}
          className="button"
          type="button"
          aria-pressed={profile.id === profileId}
          onClick={() => onChoose(profile.id)}
        >
          {profile.displayName}
        </button>
      ))}
    </div>
  );
}
