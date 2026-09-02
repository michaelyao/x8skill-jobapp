import { AddJobs } from "@/components/AddJobs";

export const dynamic = "force-dynamic";

export default function AddPage() {
  return (
    <>
      <h1>Add jobs</h1>
      <p className="sub">
        Postings you found yourself. They are a source like any other — the trackers in
        job_sites.txt are not the whole world.
      </p>
      <AddJobs />
    </>
  );
}
