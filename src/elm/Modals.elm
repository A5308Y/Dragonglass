port module Modals exposing (main)

{-| Every Dragonglass form that opens inside an Obsidian modal.

The host owns the modal shell — the overlay, Escape, and focus trapping are
Obsidian's — and this module owns what the shell contains: the fields, the
validation, and the command the form finally sends.

-}

import Browser
import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)
import Gtd.Command.Modals as Command exposing (Command, ScheduleInput(..))
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ProjectId)
import Gtd.Picker as Picker exposing (Picker)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Ui as Ui
import Html exposing (Html, button, div, h2, input, option, p, select, span, text, textarea)
import Html.Attributes exposing (checked, class, disabled, placeholder, rows, selected, step, type_, value)
import Html.Events exposing (onCheck, onClick, onInput, onSubmit)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)


port modalsToHost : Encode.Value -> Cmd msg


port modalsFromHost : (Decode.Value -> msg) -> Sub msg


{-| The time of day a schedule falls back to when an all-day Action is given a clock.
-}
defaultStartTime : String
defaultStartTime =
    "09:00"



-- FORMS


type Form
    = PromptForm PromptFields
    | CaptureForm String
    | ActionForm ActionMode ActionFields
    | ScheduleForm Action ScheduleFields
    | ImportForm ImportTarget ImportFields
    | ProjectForm ProjectMode ProjectFields
    | TagsForm (List ProjectId) String
    | ParentForm (List ProjectId) (Picker Project)
    | BlockersForm Project (Set ProjectId)
    | MissingForm String


type ActionMode
    = NewAction
    | EditAction Action Bool


type ProjectMode
    = NewProject
    | EditProject Project


type ImportTarget
    = IntoActions
    | IntoSubprojects


type alias PromptFields =
    { title : String, placeholder : String, value : String }


type alias ScheduleFields =
    { allDay : Bool, start : String, duration : String }


type alias ActionFields =
    { title : String
    , status : ActionStatus
    , project : Picker Project
    , context : Picker String
    , energy : String
    , due : String
    , deferUntil : String
    , waitingSince : String
    , schedule : ScheduleFields
    , work : Bool
    }


type alias ProjectFields =
    { title : String
    , status : ProjectStatus
    , activateAt : String
    , area : String
    , image : Picker String
    , tags : String
    , reviewed : String
    , parent : Picker Project
    }


{-| One row of a pasted list, as the host parsed it.
-}
type alias ImportedRow =
    { title : String, tags : List String, work : Bool, done : Bool }


type alias ImportFields =
    { project : Picker Project, text : String, rows : List ImportedRow }


{-| The editable text fields, named so one message can carry any of them.
-}
type Field
    = TitleField
    | PromptValueField
    | EnergyField
    | DueField
    | DeferField
    | WaitingField
    | StartField
    | DurationField
    | AreaField
    | TagsField
    | ReviewedField
    | ActivateField
    | ImportTextField


{-| What a host reply should finish.
-}
type Pending
    = IgnoreReply
    | CloseWhenDone
    | CloseWhenConfirmed
    | ApplyParsedRows String


type alias Model =
    { snapshot : Snapshot
    , images : List String
    , form : Form
    , requests : Requests Pending
    , notice : Maybe String
    , busy : Bool
    }


type Msg
    = GotHost Decode.Value
    | TextChanged Field String
    | ActionStatusChanged ActionStatus
    | ProjectStatusChanged ProjectStatus
    | ToggleAllDay Bool
    | ToggleWork Bool
    | ToggleBlocker ProjectId Bool
    | ProjectPicker (Picker.PickerMsg Project)
    | ContextPicker (Picker.PickerMsg String)
    | ImagePicker (Picker.PickerMsg String)
    | Submit
    | ConvertToSubproject
    | DeleteProject
    | Cancel
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> modalsFromHost GotHost
        , view = view
        }



-- INIT


type alias Flags =
    { snapshot : Snapshot, images : List String, form : Decode.Value }


init : Decode.Value -> ( Model, Cmd Msg )
init flagsValue =
    case Decode.decodeValue flagsDecoder flagsValue of
        Ok flags ->
            ( { snapshot = flags.snapshot
              , images = flags.images
              , form = buildForm flags.snapshot flags.images flags.form
              , requests = Host.noRequests
              , notice = Nothing
              , busy = False
              }
            , Cmd.none
            )

        Err error ->
            ( { snapshot = Data.empty
              , images = []
              , form = MissingForm (Decode.errorToString error)
              , requests = Host.noRequests
              , notice = Nothing
              , busy = False
              }
            , Cmd.none
            )


{-| Turns the host's request for a form into the form's starting state, read out
of the snapshot the same modal was opened with.
-}
buildForm : Snapshot -> List String -> Decode.Value -> Form
buildForm snapshot images spec =
    case Decode.decodeValue (Decode.field "kind" Decode.string) spec of
        Err error ->
            MissingForm (Decode.errorToString error)

        Ok kind ->
            let
                stringField name =
                    Decode.decodeValue (Decode.field name Decode.string) spec |> Result.withDefault ""

                boolField name =
                    Decode.decodeValue (Decode.field name Decode.bool) spec |> Result.withDefault False

                idsField =
                    Decode.decodeValue (Decode.field "projectIds" (Decode.list Decode.string)) spec |> Result.withDefault []

                project name =
                    Data.findProject (stringField name) snapshot.projects
            in
            case kind of
                "prompt" ->
                    PromptForm { title = stringField "title", placeholder = stringField "placeholder", value = "" }

                "capture" ->
                    CaptureForm ""

                "new-action" ->
                    ActionForm NewAction (newActionFields snapshot (project "projectId"))

                "edit-action" ->
                    case Data.findAction (stringField "actionId") snapshot.actions of
                        Just action ->
                            ActionForm (EditAction action (boolField "allowProjectConversion")) (editActionFields snapshot action)

                        Nothing ->
                            MissingForm "This Action is missing or has a duplicate ID."

                "schedule-action" ->
                    case Data.findAction (stringField "actionId") snapshot.actions of
                        Just action ->
                            ScheduleForm action (scheduleFieldsOf snapshot action)

                        Nothing ->
                            MissingForm "This Action is missing or has a duplicate ID."

                "import-actions" ->
                    ImportForm IntoActions (importFields snapshot (project "projectId"))

                "import-subprojects" ->
                    ImportForm IntoSubprojects (importFields snapshot (project "parentProjectId"))

                "new-project" ->
                    ProjectForm NewProject (newProjectFields snapshot (project "parentProjectId"))

                "edit-project" ->
                    case Data.findProject (stringField "projectId") snapshot.projects of
                        Just target ->
                            ProjectForm (EditProject target) (editProjectFields snapshot images target)

                        Nothing ->
                            MissingForm "This Project is missing or has a duplicate ID."

                "batch-tags" ->
                    TagsForm idsField ""

                "batch-parent" ->
                    ParentForm idsField (Picker.init "" Nothing)

                "dependencies" ->
                    case Data.findProject (stringField "projectId") snapshot.projects of
                        Just target ->
                            BlockersForm target
                                (Set.fromList
                                    (List.filter
                                        (\blockerId -> Data.findProject blockerId snapshot.projects /= Nothing)
                                        target.blockedByProjectIds
                                    )
                                )

                        Nothing ->
                            MissingForm "This Project is missing or has a duplicate ID."

                _ ->
                    MissingForm ("Unknown modal form: " ++ kind)


newActionFields : Snapshot -> Maybe Project -> ActionFields
newActionFields snapshot maybeProject =
    { title = ""
    , status = snapshot.settings.defaultActionStatus
    , project = projectPickerFor snapshot maybeProject
    , context = Picker.init "" Nothing
    , energy = ""
    , due = ""
    , deferUntil = ""
    , waitingSince = snapshot.today
    , schedule = { allDay = False, start = "", duration = defaultDuration snapshot }
    , work = False
    }


editActionFields : Snapshot -> Action -> ActionFields
editActionFields snapshot action =
    { title = action.title
    , status = action.status
    , project =
        case action.projectId of
            Nothing ->
                Picker.init "" Nothing

            Just projectId ->
                case Data.findProject projectId snapshot.projects of
                    Just found ->
                        Picker.init (Hierarchy.breadcrumb snapshot.projects found) (Just found)

                    Nothing ->
                        Picker.init ("Missing Project: " ++ projectId) Nothing
    , context = Picker.init (Maybe.withDefault "" action.context) action.context
    , energy = Maybe.withDefault "" action.energy
    , due = Maybe.withDefault "" action.due
    , deferUntil = Maybe.withDefault "" action.deferUntil
    , waitingSince = Maybe.withDefault snapshot.today action.waitingSince
    , schedule = scheduleFieldsOf snapshot action
    , work = action.work
    }


scheduleFieldsOf : Snapshot -> Action -> ScheduleFields
scheduleFieldsOf snapshot action =
    case Data.schedule action of
        Just (Data.AllDay date) ->
            { allDay = True, start = date, duration = defaultDuration snapshot }

        Just (Data.Timed _ minutes) ->
            { allDay = False, start = localStart action, duration = String.fromInt minutes }

        Nothing ->
            { allDay = False, start = localStart action, duration = defaultDuration snapshot }


{-| The host writes `scheduledStart` as an absolute timestamp and hands back the
local wall-clock reading, so the editor never shows a time in the wrong zone.
-}
localStart : Action -> String
localStart action =
    Maybe.withDefault "" action.scheduledLocal


defaultDuration : Snapshot -> String
defaultDuration snapshot =
    String.fromInt snapshot.settings.defaultDurationMinutes


newProjectFields : Snapshot -> Maybe Project -> ProjectFields
newProjectFields snapshot maybeParent =
    { title = ""
    , status = ProjectStatus.Active
    , activateAt = ""
    , area = ""
    , image = Picker.init "" Nothing
    , tags = ""
    , reviewed = ""
    , parent = projectPickerFor snapshot maybeParent
    }


editProjectFields : Snapshot -> List String -> Project -> ProjectFields
editProjectFields snapshot images project =
    { title = project.title
    , status = project.status
    , activateAt = Maybe.withDefault "" project.activateAt
    , area = Maybe.withDefault "" project.area
    , image = Picker.init (Maybe.withDefault "" project.image) (firstImage images (Maybe.withDefault "" project.image))
    , tags = String.join ", " project.tags
    , reviewed = Maybe.withDefault "" project.reviewed
    , parent =
        case project.parentProjectId of
            Nothing ->
                Picker.init "" Nothing

            Just parentId ->
                case Data.findProject parentId snapshot.projects of
                    Just found ->
                        Picker.init (Hierarchy.breadcrumb snapshot.projects found) (Just found)

                    Nothing ->
                        Picker.init ("Missing Project: " ++ parentId) Nothing
    }


firstImage : List String -> String -> Maybe String
firstImage images wanted =
    if String.isEmpty wanted then
        Nothing

    else
        List.filter ((==) wanted) images |> List.head


importFields : Snapshot -> Maybe Project -> ImportFields
importFields snapshot maybeProject =
    { project = projectPickerFor snapshot maybeProject, text = "", rows = [] }


projectPickerFor : Snapshot -> Maybe Project -> Picker Project
projectPickerFor snapshot maybeProject =
    case maybeProject of
        Just project ->
            Picker.init (Hierarchy.breadcrumb snapshot.projects project) (Just project)

        Nothing ->
            Picker.init "" Nothing



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        TextChanged ImportTextField typed ->
            -- The pasted list is parsed by the host, which owns the list grammar.
            case model.form of
                ImportForm target fields ->
                    send (ApplyParsedRows typed)
                        (Command.ParseImportList (importKind target) typed)
                        { model | form = ImportForm target { fields | text = typed, rows = [] }, notice = Nothing }

                _ ->
                    ( model, Cmd.none )

        TextChanged field typed ->
            ( { model | form = setField field typed model.form, notice = Nothing }, Cmd.none )

        ActionStatusChanged status ->
            ( { model | form = mapActionFields (\fields -> { fields | status = status }) model.form }, Cmd.none )

        ProjectStatusChanged status ->
            ( { model | form = mapProjectFields (\fields -> { fields | status = status }) model.form }, Cmd.none )

        ToggleAllDay allDay ->
            ( { model | form = mapSchedule (toggleAllDay allDay) model.form }, Cmd.none )

        ToggleWork work ->
            ( { model | form = mapActionFields (\fields -> { fields | work = work }) model.form }, Cmd.none )

        ToggleBlocker projectId blocked ->
            case model.form of
                BlockersForm project blockers ->
                    ( { model
                        | form =
                            BlockersForm project
                                (if blocked then
                                    Set.insert projectId blockers

                                 else
                                    Set.remove projectId blockers
                                )
                      }
                    , Cmd.none
                    )

                _ ->
                    ( model, Cmd.none )

        ProjectPicker pickerMsg ->
            ( { model | form = mapProjectPicker (Picker.update pickerMsg (projectSuggestions model) (Hierarchy.breadcrumb model.snapshot.projects)) model.form }
            , Cmd.none
            )

        ContextPicker pickerMsg ->
            ( { model | form = mapActionFields (\fields -> { fields | context = Picker.update pickerMsg (contextSuggestions model) identity fields.context }) model.form }
            , Cmd.none
            )

        ImagePicker pickerMsg ->
            ( { model | form = mapProjectFields (\fields -> { fields | image = Picker.update pickerMsg (imageSuggestions model) identity fields.image }) model.form }
            , Cmd.none
            )

        Submit ->
            submit model

        ConvertToSubproject ->
            convert model

        DeleteProject ->
            case model.form of
                ProjectForm (EditProject project) _ ->
                    send CloseWhenConfirmed (Command.TrashProject project.id) model

                _ ->
                    ( model, Cmd.none )

        Cancel ->
            send IgnoreReply Command.CloseModal model

        NoOp ->
            ( model, Cmd.none )


toggleAllDay : Bool -> ScheduleFields -> ScheduleFields
toggleAllDay allDay schedule =
    { schedule
        | allDay = allDay
        , start =
            if allDay then
                String.left 10 schedule.start

            else if String.isEmpty schedule.start then
                ""

            else
                String.left 10 schedule.start ++ "T" ++ defaultStartTime
    }


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests, busy = hasBlockingRequest requests }
    , modalsToHost (Host.envelope requestId (Command.encode command))
    )


hasBlockingRequest : Requests Pending -> Bool
hasBlockingRequest requests =
    Host.pending requests
        |> List.any
            (\pending ->
                case pending of
                    CloseWhenDone ->
                        True

                    CloseWhenConfirmed ->
                        True

                    IgnoreReply ->
                        False

                    ApplyParsedRows _ ->
                        False
            )


refuse : String -> Model -> ( Model, Cmd Msg )
refuse message model =
    ( { model | notice = Just message }, Cmd.none )



-- FIELD PLUMBING


setField : Field -> String -> Form -> Form
setField field typed form =
    case form of
        PromptForm fields ->
            PromptForm { fields | value = typed }

        CaptureForm _ ->
            CaptureForm typed

        TagsForm ids _ ->
            TagsForm ids typed

        ImportForm target fields ->
            ImportForm target { fields | text = typed }

        ActionForm mode fields ->
            ActionForm mode (setActionField field typed fields)

        ScheduleForm action schedule ->
            ScheduleForm action (setScheduleField field typed schedule)

        ProjectForm mode fields ->
            ProjectForm mode (setProjectField field typed fields)

        ParentForm _ _ ->
            form

        BlockersForm _ _ ->
            form

        MissingForm _ ->
            form


setActionField : Field -> String -> ActionFields -> ActionFields
setActionField field typed fields =
    case field of
        TitleField ->
            { fields | title = typed }

        EnergyField ->
            { fields | energy = typed }

        DueField ->
            { fields | due = typed }

        DeferField ->
            { fields | deferUntil = typed }

        WaitingField ->
            { fields | waitingSince = typed }

        StartField ->
            { fields | schedule = setScheduleField field typed fields.schedule }

        DurationField ->
            { fields | schedule = setScheduleField field typed fields.schedule }

        _ ->
            fields


setScheduleField : Field -> String -> ScheduleFields -> ScheduleFields
setScheduleField field typed schedule =
    case field of
        StartField ->
            { schedule | start = typed }

        DurationField ->
            { schedule | duration = typed }

        _ ->
            schedule


setProjectField : Field -> String -> ProjectFields -> ProjectFields
setProjectField field typed fields =
    case field of
        TitleField ->
            { fields | title = typed }

        AreaField ->
            { fields | area = typed }

        TagsField ->
            { fields | tags = typed }

        ReviewedField ->
            { fields | reviewed = typed }

        ActivateField ->
            { fields | activateAt = typed }

        _ ->
            fields


mapActionFields : (ActionFields -> ActionFields) -> Form -> Form
mapActionFields change form =
    case form of
        ActionForm mode fields ->
            ActionForm mode (change fields)

        _ ->
            form


mapProjectFields : (ProjectFields -> ProjectFields) -> Form -> Form
mapProjectFields change form =
    case form of
        ProjectForm mode fields ->
            ProjectForm mode (change fields)

        _ ->
            form


mapSchedule : (ScheduleFields -> ScheduleFields) -> Form -> Form
mapSchedule change form =
    case form of
        ActionForm mode fields ->
            ActionForm mode { fields | schedule = change fields.schedule }

        ScheduleForm action schedule ->
            ScheduleForm action (change schedule)

        _ ->
            form


{-| Every form has at most one Project field, so one message can drive it.
-}
mapProjectPicker : (Picker Project -> Picker Project) -> Form -> Form
mapProjectPicker change form =
    case form of
        ActionForm mode fields ->
            ActionForm mode { fields | project = change fields.project }

        ProjectForm mode fields ->
            ProjectForm mode { fields | parent = change fields.parent }

        ImportForm target fields ->
            ImportForm target { fields | project = change fields.project }

        ParentForm ids picker ->
            ParentForm ids (change picker)

        _ ->
            form


currentProjectPicker : Model -> Maybe (Picker Project)
currentProjectPicker model =
    case model.form of
        ActionForm _ fields ->
            Just fields.project

        ProjectForm _ fields ->
            Just fields.parent

        ImportForm _ fields ->
            Just fields.project

        ParentForm _ picker ->
            Just picker

        _ ->
            Nothing



-- SUGGESTIONS


{-| The Projects a form may choose from: a Project editor excludes itself and its
descendants, and a batch re-parent excludes the whole selection and theirs.
-}
projectCandidates : Model -> List Project
projectCandidates model =
    case model.form of
        ProjectForm (EditProject project) _ ->
            let
                excluded =
                    Set.insert project.id (Hierarchy.descendantIds project.id model.snapshot.projects)
            in
            List.filter (\candidate -> not (Set.member candidate.id excluded)) model.snapshot.projects

        ParentForm ids _ ->
            let
                excluded =
                    List.foldl
                        (\projectId acc -> Set.union acc (Set.insert projectId (Hierarchy.descendantIds projectId model.snapshot.projects)))
                        Set.empty
                        ids
            in
            List.filter (\candidate -> not (Set.member candidate.id excluded)) model.snapshot.projects

        _ ->
            model.snapshot.projects


projectSuggestions : Model -> List Project
projectSuggestions model =
    let
        typed =
            currentProjectPicker model |> Maybe.map .query |> Maybe.withDefault ""
    in
    projectCandidates model
        |> List.filter
            (\project ->
                Ui.matches typed
                    [ project.title
                    , Hierarchy.breadcrumb model.snapshot.projects project
                    , Maybe.withDefault "" project.area
                    , project.file.path
                    ]
            )
        |> List.sortBy (Hierarchy.breadcrumb model.snapshot.projects)
        |> List.take 50


contextSuggestions : Model -> List String
contextSuggestions model =
    let
        typed =
            case model.form of
                ActionForm _ fields ->
                    fields.context.query

                _ ->
                    ""
    in
    Data.contexts model.snapshot.actions
        |> List.filter (\candidate -> Ui.matches typed [ candidate ])
        |> List.take 30


imageSuggestions : Model -> List String
imageSuggestions model =
    let
        typed =
            case model.form of
                ProjectForm _ fields ->
                    fields.image.query

                _ ->
                    ""
    in
    model.images |> List.filter (\path -> Ui.matches typed [ path ]) |> List.take 50



-- SUBMIT


submit : Model -> ( Model, Cmd Msg )
submit model =
    if model.busy then
        ( model, Cmd.none )

    else
        case model.form of
            MissingForm _ ->
                ( model, Cmd.none )

            PromptForm fields ->
                if String.isEmpty (String.trim fields.value) then
                    refuse "A title is required." model

                else
                    send CloseWhenDone (Command.SubmitPrompt (String.trim fields.value)) model

            CaptureForm typed ->
                if String.isEmpty (String.trim typed) then
                    refuse "A title is required." model

                else
                    send CloseWhenDone (Command.CaptureInboxItem (String.trim typed)) model

            ActionForm mode fields ->
                submitAction mode fields model

            ScheduleForm action schedule ->
                case scheduleInput ActionStatus.Scheduled schedule of
                    Err message ->
                        refuse message model

                    Ok Nothing ->
                        refuse "Choose a scheduled start time." model

                    Ok (Just chosen) ->
                        send CloseWhenDone (Command.ScheduleAction action.id chosen) model

            ImportForm target fields ->
                submitImport target fields model

            ProjectForm mode fields ->
                submitProject mode fields model

            TagsForm ids typed ->
                case tagList typed of
                    [] ->
                        refuse "Name at least one tag." model

                    tags ->
                        send CloseWhenDone (Command.AddProjectTags ids tags) model

            ParentForm ids picker ->
                if not (Picker.isResolved picker) then
                    refuse unresolvedProject model

                else
                    send CloseWhenDone (Command.SetProjectsParent ids (Maybe.map .id (Picker.selection picker))) model

            BlockersForm project blockers ->
                send CloseWhenDone (Command.SetProjectBlockers project.id (Set.toList blockers)) model


submitAction : ActionMode -> ActionFields -> Model -> ( Model, Cmd Msg )
submitAction mode fields model =
    if String.isEmpty (String.trim fields.title) then
        refuse "An Action title is required." model

    else if ActionStatus.requiresContext fields.status && String.isEmpty (Picker.query fields.context) then
        refuse "A context is required." model

    else if not (Picker.isResolved fields.project) then
        refuse unresolvedProject model

    else
        case scheduleInput fields.status fields.schedule of
            Err message ->
                refuse message model

            Ok schedule ->
                case mode of
                    NewAction ->
                        send CloseWhenDone
                            (Command.CreateAction
                                { title = String.trim fields.title
                                , status = fields.status
                                , projectId = Maybe.map .id (Picker.selection fields.project)
                                , context = Picker.query fields.context
                                , waitingSince = waitingSince fields
                                , schedule = schedule
                                , work = fields.work
                                }
                            )
                            model

                    EditAction action _ ->
                        send CloseWhenDone
                            (Command.UpdateAction action.id
                                { title = String.trim fields.title
                                , status = fields.status
                                , projectId = Maybe.map .id (Picker.selection fields.project)
                                , context = Picker.query fields.context
                                , energy = String.trim fields.energy
                                , due = fields.due
                                , deferUntil = fields.deferUntil
                                , waitingSince = waitingSince fields
                                , schedule = schedule
                                , work = fields.work
                                }
                            )
                            model


{-| Only a Waiting Action carries a waiting date, so no date outlives its wait.
-}
waitingSince : ActionFields -> Maybe String
waitingSince fields =
    if fields.status == ActionStatus.Waiting && not (String.isEmpty fields.waitingSince) then
        Just fields.waitingSince

    else
        Nothing


{-| What the Action would reserve on the calendar, or a reason it cannot yet.

The start of a timed Action is left as typed: only the host knows the local zone
that turns it into the absolute timestamp the file stores.

-}
scheduleInput : ActionStatus -> ScheduleFields -> Result String (Maybe ScheduleInput)
scheduleInput status schedule =
    if status /= ActionStatus.Scheduled && String.isEmpty schedule.start then
        Ok Nothing

    else if String.isEmpty schedule.start then
        Err
            (if schedule.allDay then
                "Choose a scheduled date."

             else
                "Choose a scheduled start time."
            )

    else if schedule.allDay then
        if String.length schedule.start == 10 then
            Ok (Just (AllDayOn schedule.start))

        else
            Err "Choose a valid scheduled date."

    else if String.length schedule.start < 16 || not (String.contains "T" schedule.start) then
        Err "Choose a valid scheduled start time."

    else
        case String.toInt (String.trim schedule.duration) of
            Just minutes ->
                if minutes > 0 then
                    Ok (Just (TimedAt (String.left 16 schedule.start) minutes))

                else
                    Err durationMessage

            Nothing ->
                Err durationMessage


durationMessage : String
durationMessage =
    "Duration must be a positive whole number of minutes."


submitImport : ImportTarget -> ImportFields -> Model -> ( Model, Cmd Msg )
submitImport target fields model =
    if List.isEmpty fields.rows then
        refuse
            (case target of
                IntoActions ->
                    "Paste a list of Actions first."

                IntoSubprojects ->
                    "Paste a list of Sub-projects first."
            )
            model

    else if not (Picker.isResolved fields.project) then
        refuse unresolvedProject model

    else
        case target of
            IntoActions ->
                if List.any (\row -> List.isEmpty row.tags) fields.rows then
                    refuse "Every imported Action needs a context tag." model

                else
                    send CloseWhenDone (Command.ImportActionList (Maybe.map .id (Picker.selection fields.project)) fields.text) model

            IntoSubprojects ->
                case Picker.selection fields.project of
                    Nothing ->
                        refuse "Choose a parent Project." model

                    Just parent ->
                        send CloseWhenDone (Command.ImportSubprojectList parent.id fields.text) model


submitProject : ProjectMode -> ProjectFields -> Model -> ( Model, Cmd Msg )
submitProject mode fields model =
    let
        image =
            String.trim fields.image.query
    in
    if String.isEmpty (String.trim fields.title) then
        refuse "A Project title is required." model

    else if not (Picker.isResolved fields.parent) then
        refuse unresolvedProject model

    else
        case mode of
            NewProject ->
                send CloseWhenDone
                    (Command.CreateProject
                        { title = String.trim fields.title
                        , area = String.trim fields.area
                        , image = image
                        , tags = tagList fields.tags
                        , parentProjectId = Maybe.map .id (Picker.selection fields.parent)
                        }
                    )
                    model

            EditProject project ->
                send CloseWhenDone
                    (Command.UpdateProject project.id
                        { title = String.trim fields.title
                        , status = fields.status
                        , activateAt =
                            if fields.status == ProjectStatus.Someday then
                                fields.activateAt

                            else
                                ""
                        , area = String.trim fields.area
                        , image = image
                        , tags = tagList fields.tags
                        , reviewed = fields.reviewed
                        , parentProjectId = Maybe.map .id (Picker.selection fields.parent)
                        }
                    )
                    model


convert : Model -> ( Model, Cmd Msg )
convert model =
    case model.form of
        ActionForm (EditAction action _) fields ->
            if String.isEmpty (String.trim fields.title) then
                refuse "A sub-project title is required." model

            else
                case Picker.selection fields.project of
                    Nothing ->
                        refuse "Select the parent Project before converting this Action." model

                    Just parent ->
                        send CloseWhenConfirmed
                            (Command.ConvertActionToSubproject
                                { actionId = action.id, title = String.trim fields.title, parentProjectId = parent.id }
                            )
                            model

        _ ->
            ( model, Cmd.none )


importKind : ImportTarget -> Command.ImportKind
importKind target =
    case target of
        IntoActions ->
            Command.ImportActions

        IntoSubprojects ->
            Command.ImportSubprojects


tagList : String -> List String
tagList raw =
    String.split "," raw |> List.map String.trim |> List.filter (not << String.isEmpty)


unresolvedProject : String
unresolvedProject =
    "Choose a Project from the search results, or clear the Project field."



-- HOST EVENTS


type HostEvent
    = Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Err _ ->
            ( model, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests

                next =
                    { model | requests = requests, busy = hasBlockingRequest requests }
            in
            case ( outcome.result, Maybe.withDefault IgnoreReply pending ) of
                ( Err message, ApplyParsedRows source ) ->
                    if importText next.form == Just source then
                        ( { next | notice = Just message }, Cmd.none )

                    else
                        ( next, Cmd.none )

                ( Err message, _ ) ->
                    ( { next | notice = Just message }, Cmd.none )

                ( Ok _, CloseWhenDone ) ->
                    send IgnoreReply Command.CloseModal next

                ( Ok resultValue, CloseWhenConfirmed ) ->
                    -- The host asked for confirmation; a refusal leaves the form open.
                    if Decode.decodeValue Decode.bool resultValue == Ok True then
                        send IgnoreReply Command.CloseModal next

                    else
                        ( next, Cmd.none )

                ( Ok resultValue, ApplyParsedRows source ) ->
                    -- Parsing is asynchronous. A reply only belongs to the text that
                    -- issued it; an older result must never replace a newer preview.
                    if importText next.form /= Just source then
                        ( next, Cmd.none )

                    else
                        case Decode.decodeValue (Decode.list importedRowDecoder) resultValue of
                            Ok rows ->
                                ( { next | form = setRows rows next.form }, Cmd.none )

                            Err _ ->
                                ( next, Cmd.none )

                ( Ok _, IgnoreReply ) ->
                    ( next, Cmd.none )


setRows : List ImportedRow -> Form -> Form
setRows rows form =
    case form of
        ImportForm target fields ->
            ImportForm target { fields | rows = rows }

        _ ->
            form


importText : Form -> Maybe String
importText form =
    case form of
        ImportForm _ fields ->
            Just fields.text

        _ ->
            Nothing



-- VIEW


view : Model -> Html Msg
view model =
    Html.form [ onSubmit Submit ]
        (case model.form of
            MissingForm message ->
                [ h2 [] [ text "Dragonglass" ]
                , p [ class "dg-muted" ] [ text message ]
                , actions model [] (button [ type_ "button", onClick Cancel ] [ text "Close" ])
                ]

            PromptForm fields ->
                [ heading fields.title
                , settingRow "Title" "" [ textInput "text" fields.value fields.placeholder (TextChanged PromptValueField) True ]
                , noticeView model
                , actions model [] (submitButton model "Create")
                ]

            CaptureForm typed ->
                [ heading "Quick Capture Inbox Item"
                , settingRow "Title" "" [ textInput "text" typed "What's on your mind?" (TextChanged PromptValueField) True ]
                , noticeView model
                , actions model [] (submitButton model "Create")
                ]

            ActionForm mode fields ->
                actionView model mode fields

            ScheduleForm action schedule ->
                [ heading ("Schedule — " ++ action.title)
                , p [ class "dg-muted" ] [ text "Choose when this Action should occupy time on your calendar." ]
                ]
                    ++ scheduleRows schedule
                    ++ [ noticeView model, actions model [] (submitButton model "Schedule Action") ]

            ImportForm target fields ->
                importView model target fields

            ProjectForm mode fields ->
                projectView model mode fields

            TagsForm ids typed ->
                [ heading ("Add tags — " ++ projectCount (List.length ids))
                , p [ class "dg-muted" ] [ text "Existing tags are kept. Projects that already carry a tag are left untouched." ]
                , tagsRow typed
                , noticeView model
                , actions model [] (submitButton model "Add tags")
                ]

            ParentForm ids picker ->
                [ heading ("Set parent Project — " ++ projectCount (List.length ids))
                , parentProjectRow model
                    "Parent Project"
                    "Clear the field to make the selection top-level. The selected Projects and their descendants are excluded."
                    picker
                , noticeView model
                , actions model [] (submitButton model "Move Projects")
                ]

            BlockersForm project blockers ->
                blockersView model project blockers
        )


actionView : Model -> ActionMode -> ActionFields -> List (Html Msg)
actionView model mode fields =
    let
        statusRow =
            settingRow "Status" "" [ statusSelect ActionStatus.all ActionStatus.key ActionStatus.label ActionStatusChanged fields.status ]

        titleRow editing =
            settingRow "Title" "" [ textInput "text" fields.title "What is the next physical Action?" (TextChanged TitleField) (not editing) ]

        contextRow =
            settingRow "Context"
                "Optional for Waiting Actions; required for every other status."
                [ Picker.view contextPickerConfig (contextSuggestions model) fields.context ]

        conditionalRows =
            (if fields.status == ActionStatus.Waiting then
                [ settingRow "Waiting since" "The day this Action started waiting." [ dateInput fields.waitingSince WaitingField ] ]

             else
                []
            )
                ++ (if fields.status == ActionStatus.Scheduled then
                        scheduleRows fields.schedule

                    else
                        []
                   )

        workRow =
            settingRow "Work" "Independent of the Action's context." [ toggle fields.work ToggleWork ]
    in
    case mode of
        NewAction ->
            [ heading "New Action"
            , titleRow False
            , projectRow model "Project" "Type to fuzzy-search. Clear the field for no Project." fields.project
            , contextRow
            , statusRow
            ]
                ++ conditionalRows
                ++ [ workRow, noticeView model, actions model [] (submitButton model "Create Action") ]

        EditAction action allowConversion ->
            [ heading "Edit Action"
            , titleRow True
            , statusRow
            , projectRow model "Project" "Type to fuzzy-search. Clear the field for no Project." fields.project
            , contextRow
            , settingRow "Energy" "" [ textInput "text" fields.energy "medium" (TextChanged EnergyField) False ]
            , settingRow "Due" "" [ dateInput fields.due DueField ]
            , settingRow "Defer until" "" [ dateInput fields.deferUntil DeferField ]
            ]
                ++ conditionalRows
                ++ [ workRow
                   , noticeView model
                   , actions model
                        (if allowConversion && action.projectId /= Nothing then
                            [ button [ type_ "button", onClick ConvertToSubproject, disabled model.busy ] [ text "Convert to Sub-project" ] ]

                         else
                            []
                        )
                        (submitButton model "Save")
                   ]


scheduleRows : ScheduleFields -> List (Html Msg)
scheduleRows schedule =
    settingRow "All day" "Reserve the whole day instead of a time of day." [ toggle schedule.allDay ToggleAllDay ]
        :: settingRow "Scheduled start"
            "Local date and time."
            [ textInput
                (if schedule.allDay then
                    "date"

                 else
                    "datetime-local"
                )
                schedule.start
                ""
                (TextChanged StartField)
                False
            ]
        :: (if schedule.allDay then
                []

            else
                [ settingRow "Duration"
                    "Minutes reserved on the calendar."
                    [ input
                        [ type_ "number"
                        , Html.Attributes.min "1"
                        , step "1"
                        , value schedule.duration
                        , onInput (TextChanged DurationField)
                        ]
                        []
                    ]
                ]
           )


importView : Model -> ImportTarget -> ImportFields -> List (Html Msg)
importView model target fields =
    let
        ( formTitle, projectName, projectHint ) =
            case target of
                IntoActions ->
                    ( "Import Actions", "Project", "Leave empty to import the Actions without a Project." )

                IntoSubprojects ->
                    ( "Import Sub-projects", "Parent Project", "Required. Every imported Project becomes an immediate child of this Project." )

        ( listHint, listPlaceholder ) =
            case target of
                IntoActions ->
                    ( "One Action per line. “#Work” sets the work flag, any other #tag becomes the context."
                    , "- [ ] Draft the proposal #Laptop #Work"
                    )

                IntoSubprojects ->
                    ( "One Sub-project per line. Checked items become Done; #tags become Project tags."
                    , "- [ ] Research suppliers #planning\n- [x] Choose a supplier"
                    )
    in
    [ heading formTitle
    , projectRow model projectName projectHint fields.project
    , settingRow "Pasted list"
        listHint
        [ textarea
            [ class "dg-import-input"
            , rows 10
            , value fields.text
            , placeholder listPlaceholder
            , onInput (TextChanged ImportTextField)
            ]
            []
        ]
    , div [ class "dg-import-summary" ] [ text (importSummary target fields) ]
    , noticeView model
    , actions model [] (submitButton model "Import")
    ]


importSummary : ImportTarget -> ImportFields -> String
importSummary target fields =
    if List.isEmpty fields.rows then
        "Nothing to import yet."

    else
        let
            tags =
                fields.rows |> List.concatMap (List.take 1 << .tags) |> Ui.uniqueSorted
        in
        String.join " · "
            (case target of
                IntoActions ->
                    [ Ui.plural (List.length fields.rows) "Action"
                    , String.fromInt (List.length (List.filter .work fields.rows)) ++ " marked Work"
                    ]
                        ++ (if List.isEmpty tags then
                                []

                            else
                                [ "contexts: " ++ String.join ", " tags ]
                           )

                IntoSubprojects ->
                    [ Ui.plural (List.length fields.rows) "Sub-project"
                    , String.fromInt (List.length (List.filter .done fields.rows)) ++ " Done"
                    ]
                        ++ (if List.isEmpty tags then
                                []

                            else
                                [ "tags: " ++ String.join ", " tags ]
                           )
            )


projectView : Model -> ProjectMode -> ProjectFields -> List (Html Msg)
projectView model mode fields =
    let
        imageRow =
            settingRow "Main image"
                "Optional. Overrides the Default project image."
                [ Picker.view imagePickerConfig (imageSuggestions model) fields.image ]
    in
    case mode of
        NewProject ->
            [ heading
                (if Picker.selection fields.parent == Nothing then
                    "New Project"

                 else
                    "New Sub-project"
                )
            , settingRow "Title" "" [ textInput "text" fields.title "Project title" (TextChanged TitleField) True ]
            , settingRow "Area" "" [ textInput "text" fields.area "" (TextChanged AreaField) False ]
            , imageRow
            , tagsRow fields.tags
            , parentProjectRow model "Parent Project" "Optional. Type to fuzzy-search the full Project hierarchy." fields.parent
            , noticeView model
            , actions model [] (submitButton model "Create")
            ]

        EditProject _ ->
            [ heading "Edit Project"
            , settingRow "Title" "" [ textInput "text" fields.title "" (TextChanged TitleField) False ]
            , settingRow "Status" "" [ statusSelect ProjectStatus.all ProjectStatus.key ProjectStatus.label ProjectStatusChanged fields.status ]
            ]
                ++ (if fields.status == ProjectStatus.Someday then
                        [ settingRow "Activate at"
                            "On this date, move the Someday/Maybe Project to Active and show the activation on the calendar."
                            [ dateInput fields.activateAt ActivateField ]
                        ]

                    else
                        []
                   )
                ++ [ settingRow "Area" "" [ textInput "text" fields.area "" (TextChanged AreaField) False ]
                   , imageRow
                   , tagsRow fields.tags
                   , parentProjectRow model "Parent Project" "Optional. Descendants are excluded to prevent hierarchy cycles." fields.parent
                   , settingRow "Reviewed" "" [ dateInput fields.reviewed ReviewedField ]
                   , noticeView model
                   , actions model
                        [ button
                            [ type_ "button"
                            , class "mod-warning dg-modal-delete"
                            , disabled model.busy
                            , onClick DeleteProject
                            ]
                            [ text "Delete Project" ]
                        ]
                        (submitButton model "Save")
                   ]


blockersView : Model -> Project -> Set ProjectId -> List (Html Msg)
blockersView model project blockers =
    let
        candidates =
            model.snapshot.projects
                |> List.filter (\candidate -> candidate.id /= project.id)
                |> List.sortWith (siblingsFirst model project)
    in
    [ heading ("Blocked by — " ++ project.title)
    , p [ class "dg-muted" ]
        [ text "Select Projects that must finish first. Completed or cancelled blockers no longer mark this Project as blocked." ]
    , div [ class "dg-dependency-list" ]
        (if List.isEmpty candidates then
            [ span [ class "dg-muted" ] [ text "No other Projects are available." ] ]

         else
            List.map
                (\candidate ->
                    settingRow candidate.title
                        (Hierarchy.breadcrumb model.snapshot.projects candidate)
                        [ toggle (Set.member candidate.id blockers) (ToggleBlocker candidate.id) ]
                )
                candidates
        )
    , noticeView model
    , actions model [] (submitButton model "Save dependencies")
    ]


{-| Siblings of the Project come first; everything else follows by breadcrumb.
-}
siblingsFirst : Model -> Project -> Project -> Project -> Order
siblingsFirst model project left right =
    let
        rank candidate =
            if candidate.parentProjectId == project.parentProjectId then
                0

            else
                1
    in
    case compare (rank left) (rank right) of
        EQ ->
            compare
                (Hierarchy.breadcrumb model.snapshot.projects left)
                (Hierarchy.breadcrumb model.snapshot.projects right)

        order ->
            order



-- VIEW PIECES


heading : String -> Html Msg
heading formTitle =
    h2 [] [ text formTitle ]


settingRow : String -> String -> List (Html Msg) -> Html Msg
settingRow name description control =
    div [ class "setting-item" ]
        [ div [ class "setting-item-info" ]
            [ div [ class "setting-item-name" ] [ text name ]
            , if String.isEmpty description then
                text ""

              else
                div [ class "setting-item-description" ] [ text description ]
            ]
        , div [ class "setting-item-control" ] control
        ]


projectRow : Model -> String -> String -> Picker Project -> Html Msg
projectRow model name description picker =
    settingRow name description [ Picker.view (projectPickerConfig model) (projectSuggestions model) picker ]


parentProjectRow : Model -> String -> String -> Picker Project -> Html Msg
parentProjectRow model name description picker =
    projectRow model name description picker


tagsRow : String -> Html Msg
tagsRow tags =
    settingRow "Tags" "Comma-separated. Used to filter Project boards." [ textInput "text" tags "planning, home" (TextChanged TagsField) False ]


textInput : String -> String -> String -> (String -> Msg) -> Bool -> Html Msg
textInput kind current hint toMessage autofocus =
    input
        ([ type_ kind, value current, placeholder hint, onInput toMessage ]
            ++ (if autofocus then
                    [ Html.Attributes.autofocus True ]

                else
                    []
               )
        )
        []


dateInput : String -> Field -> Html Msg
dateInput current field =
    input [ type_ "date", value current, onInput (TextChanged field) ] []


toggle : Bool -> (Bool -> Msg) -> Html Msg
toggle current toMessage =
    input [ type_ "checkbox", checked current, onCheck toMessage ] []


statusSelect : List status -> (status -> String) -> (status -> String) -> (status -> Msg) -> status -> Html Msg
statusSelect all toKey toLabel toMessage current =
    select
        [ value (toKey current)
        , onInput
            (\raw ->
                List.filter (\candidate -> toKey candidate == raw) all
                    |> List.head
                    |> Maybe.map toMessage
                    |> Maybe.withDefault NoOp
            )
        ]
        (List.map
            (\candidate -> option [ value (toKey candidate), selected (toKey candidate == toKey current) ] [ text (toLabel candidate) ])
            all
        )


noticeView : Model -> Html Msg
noticeView model =
    Ui.maybeView model.notice (\message -> div [ class "dg-panel dg-error" ] [ text message ])


actions : Model -> List (Html Msg) -> Html Msg -> Html Msg
actions model extra primary =
    div [ class "dg-modal-actions" ]
        (extra
            ++ [ button [ type_ "button", onClick Cancel ] [ text "Cancel" ]
               , primary
               ]
        )


submitButton : Model -> String -> Html Msg
submitButton model label =
    button [ type_ "submit", class "mod-cta", disabled model.busy ] [ text label ]


projectCount : Int -> String
projectCount count =
    Ui.plural count "Project"


projectPickerConfig : Model -> Picker.Config Project Msg
projectPickerConfig model =
    Picker.config
        { placeholder =
            if List.isEmpty model.snapshot.projects then
                "No Projects yet"

            else
                "Search Projects…"
        , label = Hierarchy.breadcrumb model.snapshot.projects
        , hint = always Nothing
        , tag = ProjectPicker
        }


contextPickerConfig : Picker.Config String Msg
contextPickerConfig =
    Picker.config
        { placeholder = "Search or name a Context…"
        , label = identity
        , hint = always Nothing
        , tag = ContextPicker
        }


imagePickerConfig : Picker.Config String Msg
imagePickerConfig =
    Picker.config
        { placeholder = "Images/project.jpg"
        , label = identity
        , hint = always Nothing
        , tag = ImagePicker
        }



-- DECODING


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map3 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "images" (Decode.list Decode.string))
        (Decode.field "form" Decode.value)


importedRowDecoder : Decoder ImportedRow
importedRowDecoder =
    Decode.map4 ImportedRow
        (Decode.field "title" Decode.string)
        (Decode.field "tags" (Decode.list Decode.string))
        (Decode.oneOf [ Decode.field "work" Decode.bool, Decode.succeed False ])
        (Decode.oneOf [ Decode.field "done" Decode.bool, Decode.succeed False ])


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
