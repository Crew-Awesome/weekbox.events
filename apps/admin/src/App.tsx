import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  adminGrantSchema,
  eventInputSchema,
  modInputSchema,
  type EventStatus,
  type EventInput,
  type ModInput,
} from "@weekbox/shared";

type EventRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  bannerUrl: string | null;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  isVisible: boolean | number;
  version: number;
};
type ModRow = {
  id: string;
  eventId: string;
  identifier: string;
  title: string;
  description: string;
  artworkUrl: string | null;
  externalUrl: string | null;
  position: number;
  visibility: "hidden" | "revealed";
  revealedAt: string | null;
};
type UserState = {
  id: string;
  email: string;
  name: string;
  role: "owner" | "organizer";
};
type Screen = "events" | "mods" | "activity" | "organizers";
type Confirmation = {
  title: string;
  message: string;
  confirmLabel: string;
  action: () => void;
};

const localRoleKey = "weekbox.local.role";
function localRole() {
  const role = localStorage.getItem(localRoleKey);
  return role === "organizer" ? role : "owner";
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (import.meta.env.DEV) headers.set("X-WeekBox-Dev-User", localRole());
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({
    error: { message: "The API returned an unreadable response" },
  }))) as {
    data?: T;
    meta?: { total?: number; page?: number; pageSize?: number };
    error?: {
      message?: string;
      details?: Array<{ path: string; message: string }>;
    };
  };
  if (!response.ok) {
    const fields = body.error?.details
      ?.map((item) => `${item.path}: ${item.message}`)
      .join(" · ");
    throw new Error(
      fields || body.error?.message || `Request failed (${response.status})`,
    );
  }
  return body as T;
}
function query(path: string, values: Record<string, string | number>) {
  const params = new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  );
  return `${path}?${params}`;
}
function isoLocal(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function asIso(value: string) {
  return new Date(value).toISOString();
}
function prettyDate(value: string) {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
function statusColor(status: EventStatus) {
  return {
    draft: "gray",
    upcoming: "blue",
    live: "green",
    ended: "yellow",
    archived: "dark",
  }[status];
}

function Confirm({
  title,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      onClose={onCancel}
    >
      <h2 id="confirm-title">{title}</h2>
      <p>{message}</p>
      <form method="dialog">
        <button value="cancel" autoFocus>
          Cancel
        </button>
        <button
          value="confirm"
          className="danger"
          onClick={(event) => {
            event.preventDefault();
            ref.current?.close();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </form>
    </dialog>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>("events");
  const [user, setUser] = useState<UserState | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("");
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  const loadUser = async () =>
    api<{ data: UserState }>("/api/v1/admin/me").then((r) => setUser(r.data));
  const loadEvents = async () => {
    const result = await api<{ data: EventRow[] }>(
      query("/api/v1/admin/events", { page: 1, pageSize: 100, search: "" }),
    );
    setEvents(result.data);
    if (!selected && result.data[0]) setSelected(result.data[0].id);
  };
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      await loadUser();
      await loadEvents();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load WeekBox Events",
      );
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let active = true;
    async function loadInitial() {
      setBusy(true);
      try {
        const [profile, eventResponse] = await Promise.all([
          api<{ data: UserState }>("/api/v1/admin/me"),
          api<{ data: EventRow[] }>(
            query("/api/v1/admin/events", {
              page: 1,
              pageSize: 100,
              search: "",
            }),
          ),
        ]);
        if (active) {
          setUser(profile.data);
          setEvents(eventResponse.data);
          setSelected((current) => current || eventResponse.data[0]?.id || "");
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not load WeekBox Events",
          );
      } finally {
        if (active) setBusy(false);
      }
    }
    void loadInitial();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const page = String(screen);
    document.title = `${page.charAt(0).toUpperCase()}${page.slice(1)} | WeekBox Admin`;
  }, [screen]);
  const current = events.find((event) => event.id === selected) ?? events[0];
  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  };
  const mutate = async <T,>(work: () => Promise<T>, success: string) => {
    setError("");
    try {
      await work();
      await refresh();
      flash(success);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The change could not be saved",
      );
    }
  };

  return (
    <AppShell
      padding="md"
      navbar={{ width: 208, breakpoint: "sm" }}
      className="app-shell"
    >
      <AppShell.Navbar p="md" className="sidebar">
        <Text className="wordmark">
          weekbox<span>.</span>events
        </Text>
        <Divider my="sm" />
        <nav aria-label="Main navigation" className="nav-list">
          {(
            [
              ["events", "Events"],
              ["mods", "Mods"],
              ["activity", "Activity log"],
              ...(user?.role === "owner" ? [["organizers", "Organizers"]] : []),
            ] as [Screen, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={screen === key ? "nav-item active" : "nav-item"}
              onClick={() => setScreen(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Text size="sm" fw={600}>
            {user?.name ?? "Connecting…"}
          </Text>
          <Text size="xs" c="dimmed">
            {user?.role ?? ""}
          </Text>
          {import.meta.env.DEV && (
            <Select
              size="xs"
              label="Local preview role"
              value={localRole()}
              data={[
                { value: "owner", label: "Owner" },
                { value: "organizer", label: "Organizer" },
              ]}
              onChange={(role) => {
                if (role) {
                  localStorage.setItem(localRoleKey, role);
                  void refresh();
                }
              }}
            />
          )}
        </div>
      </AppShell.Navbar>
      <AppShell.Main>
        <Container fluid className="main-content">
          <header className="page-header">
            <div>
              <Title order={1}>
                {screen === "activity"
                  ? "Activity log"
                  : screen[0].toUpperCase() + screen.slice(1)}
              </Title>
            </div>
            {screen === "events" && user?.role === "owner" && (
              <Button
                onClick={() => {
                  setSelected("__new__");
                }}
              >
                New event
              </Button>
            )}
          </header>
          {error && (
            <Alert
              color="red"
              mb="md"
              withCloseButton
              onClose={() => setError("")}
            >
              {error}
            </Alert>
          )}
          {notice && (
            <Alert
              color="green"
              mb="md"
              withCloseButton
              onClose={() => setNotice("")}
            >
              {notice}
            </Alert>
          )}
          {busy ? (
            <Paper p="xl" className="surface">
              <Group>
                <Loader size="sm" />
                <Text>Loading events…</Text>
              </Group>
            </Paper>
          ) : (
            <>
              {screen === "events" && (
                <EventsScreen
                  events={events}
                  selected={selected}
                  setSelected={setSelected}
                  user={user}
                  refresh={refresh}
                  mutate={mutate}
                  setError={setError}
                  setConfirm={setConfirm}
                />
              )}
              {screen === "mods" && (
                <ModsScreen
                  events={events}
                  selected={current}
                  setSelected={setSelected}
                  user={user}
                  flash={flash}
                  setError={setError}
                  setConfirm={setConfirm}
                />
              )}
              {screen === "activity" && <ActivityScreen />}
              {screen === "organizers" && user?.role === "owner" && (
                <OrganizersScreen
                  events={events}
                  setError={setError}
                  flash={flash}
                  setConfirm={setConfirm}
                />
              )}
            </>
          )}
        </Container>
      </AppShell.Main>
      {confirm && (
        <Confirm
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { action } = confirm;
            setConfirm(null);
            action();
          }}
        />
      )}
    </AppShell>
  );
}

function EventsScreen({
  events,
  selected,
  setSelected,
  user,
  refresh,
  mutate,
  setError,
  setConfirm,
}: {
  events: EventRow[];
  selected: string;
  setSelected: (id: string) => void;
  user: UserState | null;
  refresh: () => Promise<void>;
  mutate: <T>(work: () => Promise<T>, success: string) => Promise<void>;
  setError: (message: string) => void;
  setConfirm: (confirmation: Confirmation | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [editing, setEditing] = useState<EventRow | null | false>(false);
  const [pending, setPending] = useState(false);
  const showForm = editing !== false || selected === "__new__";
  const activeEdit = selected === "__new__" ? null : editing;
  useEffect(() => {
    let active = true;
    void api<{ data: EventRow[]; meta: { total: number } }>(
      query("/api/v1/admin/events", { page, pageSize: 10, search }),
    )
      .then((result) => {
        if (active) {
          setRows(result.data);
          setTotal(result.meta.total);
        }
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : "Could not load events");
      });
    return () => {
      active = false;
    };
  }, [page, search, setError, events]);
  return (
    <div className="screen-grid">
      <Paper p="md" className="surface list-panel">
        <Group justify="space-between" mb="md">
          <Text id="event-list-heading" fw={600}>
            Events{" "}
            <Text span c="dimmed">
              {total}
            </Text>
          </Text>
        </Group>
        <search>
          <form
            action="/admin/"
            method="get"
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(searchText);
              setPage(1);
            }}
          >
            <TextInput
              name="search"
              type="search"
              aria-label="Search events"
              placeholder="Search events"
              value={searchText}
              onChange={(e) => setSearchText(e.currentTarget.value)}
            />
            <Button type="submit" variant="default">
              Search
            </Button>
          </form>
        </search>
        {rows.length === 0 ? (
          <Text c="dimmed" py="xl">
            {search ? `No events match “${search}”.` : "No events yet."}
          </Text>
        ) : (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Event search results"
          >
            <Table
              striped={false}
              highlightOnHover
              withTableBorder={false}
              verticalSpacing="xs"
              aria-labelledby="event-list-heading"
            >
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">Event</Table.Th>
                  <Table.Th scope="col">Status</Table.Th>
                  <Table.Th scope="col">Schedule</Table.Th>
                  <Table.Th scope="col">Visibility</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((event) => (
                  <Table.Tr
                    key={event.id}
                    className={selected === event.id ? "selected-row" : ""}
                  >
                    <Table.Td>
                      <button
                        type="button"
                        className="event-select-button"
                        aria-label={`Edit ${event.name}`}
                        onClick={() => {
                          setSelected(event.id);
                          setEditing(event);
                        }}
                      >
                        <Text fw={600}>{event.name}</Text>
                        <Text size="xs" c="dimmed">
                          /{event.slug}
                        </Text>
                      </button>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={statusColor(event.status)} variant="light">
                        {event.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{prettyDate(event.startsAt)}</Text>
                    </Table.Td>
                    <Table.Td>
                      {event.isVisible ? "Visible" : "Hidden"}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
        {total > 10 && (
          <Pagination
            mt="md"
            value={page}
            total={Math.ceil(total / 10)}
            onChange={setPage}
            size="sm"
          />
        )}
      </Paper>
      <Paper p="md" className="surface detail-panel">
        <Group justify="space-between">
          <Title order={2}>
            {!showForm
              ? "Select an event"
              : activeEdit
                ? "Edit event"
                : "Create event"}
          </Title>
          {showForm && (
            <Button
              variant="default"
              size="xs"
              onClick={() => {
                setEditing(false);
                if (selected === "__new__") setSelected(events[0]?.id ?? "");
              }}
            >
              Close
            </Button>
          )}
        </Group>
        <Divider my="md" />
        {showForm ? (
          <EventForm
            key={activeEdit ? activeEdit.id : "new"}
            event={activeEdit || null}
            canCreate={user?.role === "owner"}
            pending={pending}
            submit={async (value) => {
              setPending(true);
              setError("");
              try {
                if (activeEdit) {
                  await api(`/api/v1/admin/events/${activeEdit.id}`, {
                    method: "PATCH",
                    headers: { "If-Match": String(activeEdit.version) },
                    body: JSON.stringify(value),
                  });
                  setEditing(false);
                } else {
                  const result = await api<{ data: { id: string } }>(
                    "/api/v1/admin/events",
                    { method: "POST", body: JSON.stringify(value) },
                  );
                  setSelected(result.data.id);
                  setEditing(false);
                }
                await refresh();
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not save event",
                );
              } finally {
                setPending(false);
              }
            }}
            archive={
              activeEdit
                ? () =>
                    setConfirm({
                      title: "Archive this event?",
                      message:
                        "The event will disappear from the launcher and remain available in the admin archive.",
                      confirmLabel: "Archive event",
                      action: () =>
                        void mutate(
                          () =>
                            api(`/api/v1/admin/events/${activeEdit.id}`, {
                              method: "DELETE",
                              headers: {
                                "If-Match": String(activeEdit.version),
                              },
                            }),
                          "Event archived",
                        ).then(() => setEditing(false)),
                    })
                : undefined
            }
          />
        ) : (
          <Text c="dimmed">
            Choose an event to edit its details and publication status, or start
            a new event.
          </Text>
        )}
      </Paper>
    </div>
  );
}

function EventForm({
  event,
  canCreate,
  pending,
  submit,
  archive,
}: {
  event: EventRow | null;
  canCreate: boolean;
  pending: boolean;
  submit: (value: EventInput) => Promise<void>;
  archive?: () => void;
}) {
  const [message, setMessage] = useState("");
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const raw = {
      slug: String(data.slug),
      name: String(data.name),
      description: String(data.description),
      bannerUrl: String(data.bannerUrl) || null,
      startsAt: asIso(String(data.startsAt)),
      endsAt: asIso(String(data.endsAt)),
      status: String(data.status),
      isVisible: data.isVisible === "on",
    };
    const parsed = eventInputSchema.safeParse(raw);
    if (!parsed.success) {
      setMessage(parsed.error.issues.map((issue) => issue.message).join(" · "));
      return;
    }
    setMessage("");
    void submit(parsed.data);
  }
  if (event && !canCreate && event.status === "archived")
    return <Text c="dimmed">This event is archived.</Text>;
  return (
    <form onSubmit={onSubmit} className="form-stack">
      <TextInput
        label="Event title"
        name="name"
        defaultValue={event?.name}
        required
        maxLength={120}
      />
      <TextInput
        label="URL slug"
        name="slug"
        defaultValue={event?.slug}
        required
        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        description="Lowercase letters, numbers, and hyphens."
      />
      <Textarea
        label="Description"
        name="description"
        defaultValue={event?.description}
        minRows={3}
      />
      <TextInput
        label="Banner image URL"
        name="bannerUrl"
        type="url"
        defaultValue={event?.bannerUrl ?? ""}
      />
      <Group grow>
        <TextInput
          label="Starts"
          name="startsAt"
          type="datetime-local"
          defaultValue={event ? isoLocal(event.startsAt) : undefined}
          required
        />
        <TextInput
          label="Ends"
          name="endsAt"
          type="datetime-local"
          defaultValue={event ? isoLocal(event.endsAt) : undefined}
          required
        />
      </Group>
      <Select
        label="Status"
        name="status"
        defaultValue={event?.status ?? "draft"}
        data={["draft", "upcoming", "live", "ended", "archived"]}
      />
      <Checkbox
        name="isVisible"
        label="Visible to the WeekBox launcher"
        defaultChecked={Boolean(event?.isVisible)}
      />
      {message && <Alert color="red">{message}</Alert>}
      <Group justify="space-between">
        <Button type="submit" loading={pending}>
          {event ? "Save event" : "Create event"}
        </Button>
        {archive && event?.status !== "archived" && (
          <Button type="button" color="red" variant="subtle" onClick={archive}>
            Archive event
          </Button>
        )}
      </Group>
    </form>
  );
}

function ModsScreen({
  events,
  selected,
  setSelected,
  user,
  flash,
  setError,
  setConfirm,
}: {
  events: EventRow[];
  selected: EventRow | undefined;
  setSelected: (id: string) => void;
  user: UserState | null;
  flash: (message: string) => void;
  setError: (message: string) => void;
  setConfirm: (confirmation: Confirmation | null) => void;
}) {
  const [mods, setMods] = useState<ModRow[]>([]);
  const [version, setVersion] = useState(1);
  const [liveState, setLiveState] = useState("Connecting to launcher updates…");
  const [liveNotice, setLiveNotice] = useState("");
  const [editing, setEditing] = useState<ModRow | null | false>(false);
  const [pending, setPending] = useState(false);
  const writable = user?.role === "owner" || user?.role === "organizer";
  const load = async () => {
    if (!selected) return;
    try {
      const [list, event] = await Promise.all([
        api<{ data: ModRow[] }>(`/api/v1/admin/events/${selected.id}/mods`),
        api<{ data: EventRow }>(`/api/v1/admin/events/${selected.id}`),
      ]);
      setMods(list.data);
      setVersion(event.data.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load mods");
    }
  };
  const selectedId = selected?.id;
  const selectedStatus = selected?.status;
  const liveStateDisplay =
    !selectedId ||
    !selectedStatus ||
    selectedStatus === "draft" ||
    selectedStatus === "archived"
      ? "Publish this event to enable launcher updates"
      : liveState;
  useEffect(() => {
    let active = true;
    if (selectedId) {
      void Promise.all([
        api<{ data: ModRow[] }>(`/api/v1/admin/events/${selectedId}/mods`),
        api<{ data: EventRow }>(`/api/v1/admin/events/${selectedId}`),
      ])
        .then(([list, event]) => {
          if (active) {
            setMods(list.data);
            setVersion(event.data.version);
          }
        })
        .catch((e: unknown) => {
          if (active)
            setError(e instanceof Error ? e.message : "Could not load mods");
        });
    }
    return () => {
      active = false;
    };
  }, [selectedId, setError]);
  useEffect(() => {
    if (
      !selectedId ||
      !selectedStatus ||
      selectedStatus === "draft" ||
      selectedStatus === "archived"
    ) {
      return;
    }
    let stopped = false;
    let retryTimer = 0;
    let attempts = 0;
    let connection: WebSocket | undefined;
    const connect = () => {
      if (stopped) return;
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      connection = new WebSocket(
        `${scheme}//${location.host}/api/v1/events/${selectedId}/live`,
      );
      connection.addEventListener("open", () => {
        attempts = 0;
        setLiveState("Connected to launcher updates");
      });
      connection.addEventListener("message", (message) => {
        try {
          const update = JSON.parse(String(message.data)) as {
            eventId?: string;
            type?: string;
            version?: number;
          };
          if (update.eventId !== selectedId || !update.version) return;
          setLiveNotice(
            `${update.type?.replaceAll("_", " ") ?? "Event updated"} · version ${update.version}`,
          );
          void fetch(
            `/api/v1/events/${selectedId}/mods?version=${update.version}`,
          )
            .then((response) => response.json())
            .then((result: { meta?: { version?: number } }) => {
              if (result.meta?.version)
                setLiveState(
                  `Public launcher data is at version ${result.meta.version}`,
                );
            })
            .catch(() =>
              setLiveState("Update received; public data refresh failed"),
            );
        } catch {
          setLiveState("Received an unreadable launcher update");
        }
      });
      connection.addEventListener("close", () => {
        if (stopped) return;
        setLiveState("Reconnecting to launcher updates…");
        attempts += 1;
        retryTimer = window.setTimeout(
          connect,
          Math.min(30_000, 500 * 2 ** Math.min(attempts, 6)),
        );
      });
      connection.addEventListener("error", () =>
        setLiveState("Launcher update connection interrupted"),
      );
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      connection?.close();
    };
  }, [selectedId, selectedStatus]);
  async function save(value: ModInput) {
    if (!selected) return;
    setPending(true);
    try {
      if (editing) {
        await api(`/api/v1/admin/events/${selected.id}/mods/${editing.id}`, {
          method: "PATCH",
          headers: { "If-Match": String(version) },
          body: JSON.stringify(value),
        });
      } else {
        await api(`/api/v1/admin/events/${selected.id}/mods`, {
          method: "POST",
          headers: { "If-Match": String(version) },
          body: JSON.stringify(value),
        });
      }
      setEditing(false);
      await load();
      flash(editing ? "Mod saved" : "Mod added");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save mod");
    } finally {
      setPending(false);
    }
  }
  async function visibility(mod: ModRow, action: "reveal" | "hide") {
    setPending(true);
    try {
      await api(
        `/api/v1/admin/events/${selected?.id}/mods/${mod.id}/${action}`,
        { method: "POST", headers: { "If-Match": String(version) } },
      );
      await load();
      flash(
        action === "reveal"
          ? "Mod revealed to the launcher"
          : "Mod hidden from the launcher",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not change mod visibility",
      );
    } finally {
      setPending(false);
    }
  }
  async function reorder(mod: ModRow, direction: -1 | 1) {
    if (!selected) return;
    const index = mods.findIndex((item) => item.id === mod.id);
    const next = [...mods];
    const other = index + direction;
    if (other < 0 || other >= next.length) return;
    [next[index], next[other]] = [next[other], next[index]];
    setPending(true);
    try {
      await api(`/api/v1/admin/events/${selected.id}/mods/reorder`, {
        method: "POST",
        headers: { "If-Match": String(version) },
        body: JSON.stringify({ ids: next.map((item) => item.id) }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reorder mods");
    } finally {
      setPending(false);
    }
  }
  if (!selected)
    return <Empty>Select an event before managing its mods.</Empty>;
  return (
    <Stack>
      <Group>
        <Select
          label="Event"
          value={selected.id}
          data={events.map((event) => ({ value: event.id, label: event.name }))}
          onChange={(value) => {
            if (!value) return;
            setEditing(false);
            setMods([]);
            setVersion(1);
            setSelected(value);
          }}
        />
        <Stack gap={2} mt="xl">
          <Text size="sm" c="dimmed">
            Event version {version}
          </Text>
          <Text size="xs" c="dimmed">
            {liveStateDisplay}
            {liveNotice ? ` · ${liveNotice}` : ""}
          </Text>
        </Stack>
        {writable && (
          <Button mt="xl" onClick={() => setEditing(null)}>
            Add mod
          </Button>
        )}
      </Group>
      {mods.length === 0 ? (
        <Empty>No mods yet. Add the first entry for {selected.name}.</Empty>
      ) : (
        <Paper
          className="surface table-wrap"
          tabIndex={0}
          role="region"
          aria-label={`Mods for ${selected.name}`}
        >
          <Table aria-label={`Mods for ${selected.name}`}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">Position</Table.Th>
                <Table.Th scope="col">Mod</Table.Th>
                <Table.Th scope="col">Launcher preview</Table.Th>
                <Table.Th scope="col">Visibility</Table.Th>
                <Table.Th scope="col">Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {mods.map((mod, index) => (
                <Table.Tr key={mod.id}>
                  <Table.Td>
                    <Group gap={4}>
                      <ActionIcon
                        aria-label={`Move ${mod.title} up`}
                        variant="default"
                        disabled={index === 0 || pending || !writable}
                        onClick={() => void reorder(mod, -1)}
                      >
                        ↑
                      </ActionIcon>
                      <ActionIcon
                        aria-label={`Move ${mod.title} down`}
                        variant="default"
                        disabled={
                          index === mods.length - 1 || pending || !writable
                        }
                        onClick={() => void reorder(mod, 1)}
                      >
                        ↓
                      </ActionIcon>
                      <Text size="sm">{index + 1}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text fw={600}>{mod.title}</Text>
                    <Text size="xs" c="dimmed">
                      {mod.identifier}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <div className="mod-preview">
                      <Text fw={600}>
                        {mod.visibility === "revealed"
                          ? mod.title
                          : "Hidden mod"}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {mod.visibility === "revealed"
                          ? mod.description
                          : "This entry is not shown to players yet."}
                      </Text>
                    </div>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      color={mod.visibility === "revealed" ? "green" : "gray"}
                      variant="light"
                    >
                      {mod.visibility}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="default"
                        disabled={!writable}
                        onClick={() => setEditing(mod)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="default"
                        disabled={!writable || pending}
                        onClick={() =>
                          setConfirm({
                            title:
                              mod.visibility === "revealed"
                                ? "Hide this mod?"
                                : "Reveal this mod?",
                            message:
                              "This visibility change is published immediately to the WeekBox launcher.",
                            confirmLabel:
                              mod.visibility === "revealed"
                                ? "Hide mod"
                                : "Reveal mod",
                            action: () =>
                              void visibility(
                                mod,
                                mod.visibility === "revealed"
                                  ? "hide"
                                  : "reveal",
                              ),
                          })
                        }
                      >
                        {mod.visibility === "revealed" ? "Hide" : "Reveal"}
                      </Button>
                      <Button
                        size="xs"
                        color="red"
                        variant="subtle"
                        disabled={!writable}
                        onClick={() =>
                          setConfirm({
                            title: "Remove this mod?",
                            message:
                              "This removes the mod from this event. The change is published immediately.",
                            confirmLabel: "Remove mod",
                            action: () =>
                              void api(
                                `/api/v1/admin/events/${selected.id}/mods/${mod.id}`,
                                {
                                  method: "DELETE",
                                  headers: { "If-Match": String(version) },
                                },
                              )
                                .then(load)
                                .then(() => flash("Mod removed"))
                                .catch((e: Error) => setError(e.message)),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
      {editing !== false && (
        <Paper p="md" className="surface">
          <Group justify="space-between">
            <Title order={2}>{editing ? "Edit mod" : "Add mod"}</Title>
            <Button variant="default" onClick={() => setEditing(false)}>
              Close
            </Button>
          </Group>
          <ModForm
            key={editing?.id ?? "new"}
            mod={editing || null}
            pending={pending}
            submit={save}
          />
        </Paper>
      )}
    </Stack>
  );
}

function ModForm({
  mod,
  pending,
  submit,
}: {
  mod: ModRow | null;
  pending: boolean;
  submit: (value: ModInput) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget));
    const parsed = modInputSchema.safeParse({
      identifier: d.identifier,
      title: d.title,
      description: d.description,
      artworkUrl: String(d.artworkUrl) || null,
      externalUrl: String(d.externalUrl) || null,
      position: mod?.position,
    });
    if (!parsed.success) {
      setMessage(parsed.error.issues.map((i) => i.message).join(" · "));
      return;
    }
    void submit(parsed.data);
  }
  return (
    <form onSubmit={onSubmit} className="form-stack">
      <TextInput
        label="Mod title"
        name="title"
        defaultValue={mod?.title}
        required
      />
      <TextInput
        label="Launcher identifier"
        name="identifier"
        defaultValue={mod?.identifier}
        required
      />
      <Textarea
        label="Description"
        name="description"
        defaultValue={mod?.description}
        minRows={3}
      />
      <TextInput
        label="Artwork URL"
        name="artworkUrl"
        type="url"
        defaultValue={mod?.artworkUrl ?? ""}
      />
      <TextInput
        label="itch.io or external URL"
        name="externalUrl"
        type="url"
        defaultValue={mod?.externalUrl ?? ""}
      />
      {message && <Alert color="red">{message}</Alert>}
      <Button type="submit" loading={pending}>
        {mod ? "Save mod" : "Add mod"}
      </Button>
    </form>
  );
}

function ActivityScreen() {
  const [items, setItems] = useState<
    Array<{
      id: string;
      action: string;
      entityType: string;
      actor: string | null;
      createdAt: string;
      details: string;
    }>
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<{ data: typeof items }>(
      query("/api/v1/admin/activity", { page: 1, pageSize: 50, search: "" }),
    )
      .then((r) => {
        if (active) setItems(r.data);
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : "Could not load activity");
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <Paper p="md" className="surface">
      <Title order={2} mb="md">
        Recent changes
      </Title>
      {error ? (
        <Alert color="red">{error}</Alert>
      ) : items.length === 0 ? (
        <Empty>No activity has been recorded yet.</Empty>
      ) : (
        <Stack gap="xs">
          {items.map((item) => (
            <Group
              key={item.id}
              justify="space-between"
              className="activity-row"
            >
              <Text>
                <strong>{item.actor ?? "System"}</strong> {item.action}{" "}
                {item.entityType}
              </Text>
              <Text size="xs" c="dimmed">
                {prettyDate(item.createdAt)}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function OrganizersScreen({
  events,
  setError,
  flash,
  setConfirm,
}: {
  events: EventRow[];
  setError: (message: string) => void;
  flash: (message: string) => void;
  setConfirm: (confirmation: Confirmation | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [members, setMembers] = useState<
    Array<{
      id: string;
      email: string;
      displayName: string;
      role: string;
      active: number;
    }>
  >([]);
  const loadMembers = async () => {
    const result = await api<{ data: { users: typeof members } }>(
      "/api/v1/admin/users",
    );
    setMembers(result.data.users);
  };
  useEffect(() => {
    let active = true;
    void api<{ data: { users: typeof members } }>("/api/v1/admin/users")
      .then((result) => {
        if (active) setMembers(result.data.users);
      })
      .catch((e: unknown) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not load team access",
          );
      });
    return () => {
      active = false;
    };
  }, [setError]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = Object.fromEntries(new FormData(form));
    const parsed = adminGrantSchema.safeParse({
      email: d.email,
      displayName: d.displayName,
      eventIds: events
        .filter((event) => d[`event-${event.id}`] === "on")
        .map((event) => event.id),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" · "));
      return;
    }
    setPending(true);
    try {
      await api("/api/v1/admin/users", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      form.reset();
      await loadMembers();
      flash("Access assignment saved");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not grant access",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Stack>
      <Paper p="md" className="surface">
        <Title order={2}>Organizers</Title>
        <Text c="dimmed" size="sm" my="sm">
          Add the email to the Cloudflare Access allow policy, then assign this
          Organizer to the events they manage.
        </Text>
        <form onSubmit={submit} className="form-stack">
          <TextInput label="Account email" name="email" type="email" required />
          <TextInput label="Display name" name="displayName" required />
          <fieldset className="event-checks">
            <legend>Events this person may access</legend>
            {events.length === 0 ? (
              <Text c="dimmed">Create an event first.</Text>
            ) : (
              events.map((event) => (
                <Checkbox
                  key={event.id}
                  name={`event-${event.id}`}
                  label={event.name}
                />
              ))
            )}
          </fieldset>
          <Button type="submit" loading={pending}>
            Save access
          </Button>
        </form>
      </Paper>
      <Paper p="md" className="surface">
        <Title order={2} mb="md">
          Team members
        </Title>
        {members.length === 0 ? (
          <Empty>No accounts have been granted access.</Empty>
        ) : (
          <Stack gap="xs">
            {members.map((member) => (
              <Group
                key={member.id}
                justify="space-between"
                className="activity-row"
              >
                <div>
                  <Text fw={600}>{member.displayName}</Text>
                  <Text size="xs" c="dimmed">
                    {member.email} · {member.role}
                    {member.active ? "" : " · revoked"}
                  </Text>
                </div>
                {member.role !== "owner" && member.active === 1 && (
                  <Button
                    size="xs"
                    color="red"
                    variant="subtle"
                    onClick={() =>
                      setConfirm({
                        title: `Revoke ${member.displayName}’s access?`,
                        message:
                          "They will no longer be able to access assigned events.",
                        confirmLabel: "Revoke access",
                        action: () =>
                          void api(`/api/v1/admin/users/${member.id}`, {
                            method: "DELETE",
                          })
                            .then(loadMembers)
                            .then(() => flash("Access revoked"))
                            .catch((e: Error) => setError(e.message)),
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </Group>
            ))}
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <Paper p="xl" className="empty-state">
      <Text fw={600}>{children}</Text>
    </Paper>
  );
}
