#include "GDCore/Project/ExternalEvents.h"

#include "ExternalEvents.h"
#include "GDCore/Events/Event.h"
#include "GDCore/Events/Serialization.h"
#include "GDCore/Serialization/SerializerElement.h"
#include "GDCore/Tools/UUID/UUID.h"

namespace gd {

ExternalEvents::ExternalEvents() : persistentUuid(UUID::MakeUuid4()) {}

ExternalEvents::ExternalEvents(const ExternalEvents& externalEvents) {
  Init(externalEvents);
}

ExternalEvents& ExternalEvents::operator=(const ExternalEvents& rhs) {
  if (this != &rhs) Init(rhs);

  return *this;
}

void ExternalEvents::Init(const ExternalEvents& externalEvents) {
  name = externalEvents.GetName();
  persistentUuid = externalEvents.persistentUuid;
  associatedScene = externalEvents.GetAssociatedLayout();
  events = externalEvents.events;
}

ExternalEvents& ExternalEvents::ResetPersistentUuid() {
  persistentUuid = UUID::MakeUuid4();
  return *this;
}

void ExternalEvents::SerializeTo(SerializerElement& element) const {
  element.SetAttribute("name", name);
  element.SetStringAttribute("persistentUuid", persistentUuid);
  element.SetAttribute("associatedLayout", associatedScene);
  gd::EventsListSerialization::SerializeEventsTo(events,
                                                 element.AddChild("events"));
}

void ExternalEvents::UnserializeFrom(gd::Project& project,
                                     const SerializerElement& element) {
  persistentUuid = element.GetStringAttribute("persistentUuid");
  if (persistentUuid.empty()) ResetPersistentUuid();
  name = element.GetStringAttribute("name", "", "Name");
  associatedScene =
      element.GetStringAttribute("associatedLayout", "", "AssociatedScene");
  gd::EventsListSerialization::UnserializeEventsFrom(
      project, events, element.GetChild("events", 0, "Events"));
}

}  // namespace gd
