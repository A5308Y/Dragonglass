port module Pomodoro exposing (main)

{-| A focused time slice on one Project. Before it starts: pick the Project, see
its Next Actions, and set an intention. While it runs: the intention and the time
left. After it ends: a short wrap-up, filed in the history below.

The session itself is kept by the host, so it survives closing this view. This
view only counts down from the start and pause times the host reports.

-}

import Browser
import Dict
import Gtd.ActionStatus as ActionStatus
import Gtd.Command.Pomodoro as Command exposing (Command)
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.Picker as Picker exposing (Picker)
import Gtd.PomodoroOutcome as Outcome exposing (PomodoroOutcome)
import Gtd.ProjectStatus as ProjectStatus
import Gtd.Ui as Ui
import Html exposing (Html, article, button, div, h2, h3, header, input, label, li, p, section, span, strong, text, textarea, ul)
import Html.Attributes exposing (attribute, checked, class, classList, disabled, for, id, placeholder, rows, style, title, type_, value)
import Html.Events exposing (onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
import Time


port pomodoroToHost : Encode.Value -> Cmd msg


port pomodoroFromHost : (Decode.Value -> msg) -> Sub msg



-- STATE FROM THE HOST


type alias Active =
    { id : String
    , projectId : ProjectId
    , projectTitle : String
    , intention : String
    , focusActionIds : List ActionId
    , completedActionIds : List ActionId
    , plannedMinutes : Int
    , focusedBefore : Float
    , resumedAtMs : Maybe Int
    , startedTime : String
    }


type alias Session =
    { id : String
    , projectId : ProjectId
    , projectTitle : String
    , projectPath : String
    , intention : String
    , day : String
    , startedTime : String
    , endedTime : String
    , focusedMinutes : Int
    , stoppedEarly : Bool
    , outcome : Maybe PomodoroOutcome
    , reflection : String
    , completedActions : Int
    }


type alias PomodoroState =
    { focusMinutes : Int
    , active : Maybe Active
    , sessions : List Session
    , today : String
    , weekStart : String
    }



-- MODEL


type Scope
    = AllProjects
    | ThisProject


type alias Model =
    { snapshot : Snapshot
    , state : PomodoroState
    , nowMs : Int
    , project : Picker Project
    , focusIds : Set ActionId
    , intention : String
    , minutes : String
    , wrappingUp : Bool
    , outcome : Maybe PomodoroOutcome
    , reflection : String
    , scope : Scope
    , historyLimit : Int
    , requests : Requests ()
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | Tick Time.Posix
    | ProjectPicker (Picker.PickerMsg Project)
    | ToggleFocus ActionId Bool
    | IntentionChanged String
    | MinutesChanged String
    | Start
    | Pause
    | Resume
    | FinishEarly
    | KeepGoing
    | ChooseOutcome PomodoroOutcome
    | ReflectionChanged String
    | Finish
    | Discard
    | CompleteAction ActionId
    | SetScope Scope
    | ShowMore
    | Send Command
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = subscriptions
        , view = view
        }


type alias Flags =
    { snapshot : Snapshot, state : PomodoroState, initialProjectId : Maybe ProjectId, nowMs : Int }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok decoded ->
            ( selectProject decoded.initialProjectId (initialModel decoded.snapshot decoded.state decoded.nowMs), Cmd.none )

        Err error ->
            let
                blank =
                    initialModel Data.empty emptyState 0
            in
            ( { blank | error = Just (Decode.errorToString error) }, Cmd.none )


initialModel : Snapshot -> PomodoroState -> Int -> Model
initialModel snapshot state nowMs =
    { snapshot = snapshot
    , state = state
    , nowMs = nowMs
    , project = Picker.init "" Nothing
    , focusIds = Set.empty
    , intention = ""
    , minutes = String.fromInt state.focusMinutes
    , wrappingUp = False
    , outcome = Nothing
    , reflection = ""
    , scope = AllProjects
    , historyLimit = 20
    , requests = Host.noRequests
    , error = Nothing
    }


emptyState : PomodoroState
emptyState =
    { focusMinutes = 25, active = Nothing, sessions = [], today = "", weekStart = "" }


selectProject : Maybe ProjectId -> Model -> Model
selectProject maybeId model =
    case maybeId |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects) of
        Just project ->
            { model
                | project = Picker.init (Hierarchy.breadcrumb model.snapshot.projects project) (Just project)
                , focusIds = Set.empty
                , scope = ThisProject
            }

        Nothing ->
            model


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch
        [ pomodoroFromHost GotHost
        , if model.state.active /= Nothing then
            Time.every 1000 Tick

          else
            Sub.none
        ]



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        Tick now ->
            ( { model | nowMs = Time.posixToMillis now }, Cmd.none )

        ProjectPicker pickerMsg ->
            let
                picked =
                    Picker.update pickerMsg (projectSuggestions model) (Hierarchy.breadcrumb model.snapshot.projects) model.project
            in
            ( { model
                | project = picked
                , focusIds =
                    if Maybe.map .id (Picker.selection picked) /= Maybe.map .id (Picker.selection model.project) then
                        Set.empty

                    else
                        model.focusIds
              }
            , Cmd.none
            )

        ToggleFocus actionId on ->
            ( { model
                | focusIds =
                    if on then
                        Set.insert actionId model.focusIds

                    else
                        Set.remove actionId model.focusIds
              }
            , Cmd.none
            )

        IntentionChanged intention ->
            ( { model | intention = intention }, Cmd.none )

        MinutesChanged minutes ->
            ( { model | minutes = minutes }, Cmd.none )

        Start ->
            case ( Picker.selection model.project, plannedMinutes model ) of
                ( Just project, Just minutes ) ->
                    if String.isEmpty (String.trim model.intention) then
                        ( model, Cmd.none )

                    else
                        send
                            (Command.StartPomodoro
                                { projectId = project.id
                                , intention = String.trim model.intention
                                , focusActionIds = Set.toList model.focusIds
                                , minutes = minutes
                                }
                            )
                            { model | wrappingUp = False, outcome = Nothing, reflection = "" }

                _ ->
                    ( model, Cmd.none )

        Pause ->
            send Command.PausePomodoro model

        Resume ->
            send Command.ResumePomodoro model

        FinishEarly ->
            -- Writing the wrap-up is not focus time, so the clock stops while it is open.
            send Command.PausePomodoro { model | wrappingUp = True }

        KeepGoing ->
            send Command.ResumePomodoro { model | wrappingUp = False }

        ChooseOutcome outcome ->
            ( { model | outcome = Just outcome }, Cmd.none )

        ReflectionChanged reflection ->
            ( { model | reflection = reflection }, Cmd.none )

        Finish ->
            send (Command.FinishPomodoro model.outcome (String.trim model.reflection))
                { model | wrappingUp = False, outcome = Nothing, reflection = "", intention = "", focusIds = Set.empty }

        Discard ->
            send Command.DiscardPomodoro { model | wrappingUp = False, outcome = Nothing, reflection = "" }

        CompleteAction actionId ->
            send (Command.CompletePomodoroAction actionId) model

        SetScope scope ->
            ( { model | scope = scope }, Cmd.none )

        ShowMore ->
            ( { model | historyLimit = model.historyLimit + 20 }, Cmd.none )

        Send command ->
            send command model

        NoOp ->
            ( model, Cmd.none )


send : Command -> Model -> ( Model, Cmd Msg )
send command model =
    let
        ( requestId, requests ) =
            Host.issue () model.requests
    in
    ( { model | requests = requests, error = Nothing }, pomodoroToHost (Host.envelope requestId (Command.encode command)) )


plannedMinutes : Model -> Maybe Int
plannedMinutes model =
    String.toInt (String.trim model.minutes)
        |> Maybe.andThen
            (\minutes ->
                if minutes >= 1 && minutes <= 180 then
                    Just minutes

                else
                    Nothing
            )



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | StateEvent PomodoroState
    | SelectProjectEvent ProjectId
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (SnapshotEvent snapshot) ->
            ( { model | snapshot = snapshot }, Cmd.none )

        Ok (StateEvent state) ->
            let
                -- A session finished or discarded elsewhere closes the wrap-up here too.
                wrappingUp =
                    model.wrappingUp && state.active /= Nothing
            in
            ( { model | state = state, wrappingUp = wrappingUp }, Cmd.none )

        Ok (SelectProjectEvent projectId) ->
            ( selectProject (Just projectId) model, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( _, requests ) =
                    Host.resolve outcome.requestId model.requests
            in
            case outcome.result of
                Err message ->
                    ( { model | requests = requests, error = Just message }, Cmd.none )

                Ok _ ->
                    ( { model | requests = requests }, Cmd.none )

        Err error ->
            ( { model | error = Just (Decode.errorToString error) }, Cmd.none )



-- QUERIES


{-| Seconds focused so far, the same way the host counts them.
-}
focused : Model -> Active -> Int
focused model active =
    let
        running =
            case active.resumedAtMs of
                Just resumedAt ->
                    toFloat (max 0 (model.nowMs - resumedAt)) / 1000

                Nothing ->
                    0
    in
    min (active.plannedMinutes * 60) (floor (active.focusedBefore + running))


remaining : Model -> Active -> Int
remaining model active =
    active.plannedMinutes * 60 - focused model active


openProjects : Model -> List Project
openProjects model =
    List.filter (\project -> ProjectStatus.isOpen project.status) model.snapshot.projects


projectSuggestions : Model -> List Project
projectSuggestions model =
    openProjects model
        |> List.filter
            (\project ->
                Ui.matches (Picker.query model.project)
                    [ project.title, Hierarchy.breadcrumb model.snapshot.projects project, Maybe.withDefault "" project.area ]
            )
        |> List.sortBy
            (\project ->
                ( if project.status == ProjectStatus.Active then
                    0

                  else
                    1
                , Hierarchy.breadcrumb model.snapshot.projects project
                )
            )
        |> List.take 30


nextActions : Model -> ProjectId -> List Action
nextActions model projectId =
    model.snapshot.actions
        |> List.filter (\action -> action.projectId == Just projectId && action.status == ActionStatus.Next)
        |> List.sortBy (\action -> ( Maybe.withDefault 999999 action.priority, action.created ))


scopedSessions : Model -> List Session
scopedSessions model =
    case ( model.scope, scopeProjectId model ) of
        ( ThisProject, Just projectId ) ->
            List.filter (\session -> session.projectId == projectId) model.state.sessions

        _ ->
            model.state.sessions


scopeProjectId : Model -> Maybe ProjectId
scopeProjectId model =
    case model.state.active of
        Just active ->
            Just active.projectId

        Nothing ->
            Picker.selection model.project |> Maybe.map .id



-- VIEW


view : Model -> Html Msg
view model =
    div [ class "dg-view dg-pomodoro-view" ]
        [ header [ class "dg-view-header" ]
            [ div [] [ h2 [] [ text "Pomodoro" ] ] ]
        , Ui.maybeView model.error (\message -> div [ class "dg-panel dg-error" ] [ text message ])
        , div [ class "dg-pomodoro-body" ]
            [ case model.state.active of
                Just active ->
                    if model.wrappingUp || remaining model active <= 0 then
                        wrapUpView model active

                    else
                        runningView model active

                Nothing ->
                    setupView model
            , historyView model
            ]
        ]


setupView : Model -> Html Msg
setupView model =
    let
        selected =
            Picker.selection model.project

        ready =
            selected /= Nothing && not (String.isEmpty (String.trim model.intention)) && plannedMinutes model /= Nothing
    in
    section [ class "dg-pomodoro-card", attribute "aria-label" "New Pomodoro" ]
        [ h3 [] [ text "New Pomodoro" ]
        , div [ class "dg-pomodoro-field" ]
            [ span [ class "dg-pomodoro-label" ] [ text "Project" ]
            , Picker.view
                (Picker.config
                    { placeholder = "Search Projects…"
                    , label = Hierarchy.breadcrumb model.snapshot.projects
                    , hint = .area
                    , tag = ProjectPicker
                    }
                )
                (projectSuggestions model)
                model.project
            ]
        , case selected of
            Just project ->
                focusPicker model project

            Nothing ->
                text ""
        , div [ class "dg-pomodoro-field" ]
            [ label [ class "dg-pomodoro-label", for "dg-pomodoro-intention" ] [ text "Intention" ]
            , textarea
                [ id "dg-pomodoro-intention"
                , rows 3
                , value model.intention
                , placeholder ("What will be true at the end of these " ++ model.minutes ++ " minutes?")
                , onInput IntentionChanged
                , Ui.onModEnter
                    { save =
                        if ready then
                            Start

                        else
                            NoOp
                    , ignore = NoOp
                    }
                ]
                []
            ]
        , div [ class "dg-pomodoro-start" ]
            [ label [ class "dg-pomodoro-minutes" ]
                [ input
                    [ type_ "number"
                    , Html.Attributes.min "1"
                    , Html.Attributes.max "180"
                    , value model.minutes
                    , attribute "aria-label" "Length in minutes"
                    , onInput MinutesChanged
                    ]
                    []
                , span [] [ text "minutes" ]
                ]
            , button [ class "mod-cta", disabled (not ready), title "Start (⌘/Ctrl+Enter in the intention)", onClick Start ] [ text "Start Pomodoro" ]
            ]
        ]


{-| The Project's Next Actions, any of which can be picked as this session's focus.
-}
focusPicker : Model -> Project -> Html Msg
focusPicker model project =
    let
        actions =
            nextActions model project.id
    in
    div [ class "dg-pomodoro-field" ]
        [ span [ class "dg-pomodoro-label" ] [ text "Next Actions" ]
        , if List.isEmpty actions then
            p [ class "dg-muted" ] [ text "This Project has no Next Actions. The intention can say what the session is for." ]

          else
            ul [ class "dg-pomodoro-actions" ]
                (List.map
                    (\action ->
                        li []
                            [ label []
                                [ input [ type_ "checkbox", checked (Set.member action.id model.focusIds), onCheck (ToggleFocus action.id) ] []
                                , span [] [ text action.title ]
                                ]
                            ]
                    )
                    actions
                )
        , if List.isEmpty actions then
            text ""

          else
            small "Tick the ones this session is for, if any."
        ]


runningView : Model -> Active -> Html Msg
runningView model active =
    let
        left =
            remaining model active

        paused =
            active.resumedAtMs == Nothing

        progress =
            toFloat (focused model active) / toFloat (active.plannedMinutes * 60) * 100
    in
    section [ class "dg-pomodoro-card dg-pomodoro-running", attribute "aria-label" "Running Pomodoro" ]
        [ div [ class "dg-pomodoro-project" ]
            [ span [] [ text ("Since " ++ active.startedTime) ]
            , button [ class "dg-flat-button dg-pomodoro-project-link", onClick (Send (Command.ShowProject active.projectId)) ] [ text active.projectTitle ]
            ]
        , div [ classList [ ( "dg-pomodoro-clock", True ), ( "is-paused", paused ) ], attribute "role" "timer", attribute "aria-live" "off" ]
            [ text (Ui.timer left)
            , if paused then
                span [ class "dg-pomodoro-paused" ] [ text "Paused" ]

              else
                text ""
            ]
        , div [ class "dg-progress-track" ] [ span [ style "width" (String.fromFloat progress ++ "%") ] [] ]
        , blockquote active.intention
        , sessionActions model active
        , div [ class "dg-pomodoro-controls" ]
            [ if paused then
                button [ class "mod-cta", onClick Resume ] [ text "Resume" ]

              else
                button [ onClick Pause ] [ text "Pause" ]
            , button [ onClick FinishEarly ] [ text "Finish early" ]
            , button [ class "mod-warning", title "Throw this session away (can be undone)", onClick Discard ] [ text "Discard" ]
            ]
        ]


{-| The Actions picked for this session first, then the Project's other Next
Actions, each of which can be ticked off without leaving the timer.
-}
sessionActions : Model -> Active -> Html Msg
sessionActions model active =
    let
        byId =
            Dict.fromList (List.map (\action -> ( action.id, action )) model.snapshot.actions)

        picked =
            List.filterMap (\actionId -> Dict.get actionId byId) active.focusActionIds

        others =
            nextActions model active.projectId |> List.filter (\action -> not (List.member action.id active.focusActionIds))

        row action =
            let
                done =
                    action.status == ActionStatus.Done
            in
            li [ classList [ ( "is-done", done ) ] ]
                [ label []
                    [ input
                        [ type_ "checkbox"
                        , checked done
                        , disabled done
                        , attribute "aria-label" ("Mark “" ++ action.title ++ "” done")
                        , onCheck (\_ -> CompleteAction action.id)
                        ]
                        []
                    , span [] [ text action.title ]
                    ]
                ]
    in
    div [ class "dg-pomodoro-field" ]
        (if List.isEmpty picked && List.isEmpty others then
            []

         else
            [ span [ class "dg-pomodoro-label" ]
                [ text
                    (if List.isEmpty picked then
                        "Next Actions"

                     else
                        "Focus"
                    )
                ]
            , ul [ class "dg-pomodoro-actions" ] (List.map row picked)
            , if List.isEmpty picked || List.isEmpty others then
                text ""

              else
                span [ class "dg-pomodoro-label" ] [ text "Other Next Actions" ]
            , ul [ class "dg-pomodoro-actions" ] (List.map row others)
            ]
        )


wrapUpView : Model -> Active -> Html Msg
wrapUpView model active =
    let
        timeUp =
            remaining model active <= 0
    in
    section [ class "dg-pomodoro-card dg-pomodoro-wrapup", attribute "aria-label" "Wrap up" ]
        [ h3 []
            [ text
                (if timeUp then
                    "Time's up — how did it go?"

                 else
                    "Finishing early — how did it go?"
                )
            ]
        , div [ class "dg-pomodoro-project" ]
            [ span [] [ text (String.fromInt (focused model active // 60) ++ " of " ++ String.fromInt active.plannedMinutes ++ " minutes on") ]
            , strong [] [ text active.projectTitle ]
            ]
        , blockquote active.intention
        , div [ class "dg-pomodoro-outcomes", attribute "role" "radiogroup", attribute "aria-label" "Outcome" ]
            (List.map
                (\outcome ->
                    button
                        [ classList [ ( "dg-pomodoro-outcome", True ), ( "is-active", model.outcome == Just outcome ) ]
                        , attribute "role" "radio"
                        , attribute "aria-checked" (Ui.boolAttribute (model.outcome == Just outcome))
                        , onClick (ChooseOutcome outcome)
                        ]
                        [ text (Outcome.symbol outcome ++ " " ++ Outcome.label outcome) ]
                )
                Outcome.all
            )
        , div [ class "dg-pomodoro-field" ]
            [ label [ class "dg-pomodoro-label", for "dg-pomodoro-reflection" ] [ text "Reflection (optional)" ]
            , textarea
                [ id "dg-pomodoro-reflection"
                , rows 3
                , value model.reflection
                , placeholder "What got done? What got in the way? What comes next?"
                , onInput ReflectionChanged
                , Ui.onModEnter { save = Finish, ignore = NoOp }
                ]
                []
            ]
        , sessionActions model active
        , div [ class "dg-pomodoro-controls" ]
            [ button [ class "mod-cta", title "Save to the history (⌘/Ctrl+Enter in the reflection)", onClick Finish ] [ text "Save session" ]
            , if timeUp then
                text ""

              else
                button [ onClick KeepGoing ] [ text "Keep going" ]
            , button [ class "mod-warning", title "Throw this session away (can be undone)", onClick Discard ] [ text "Discard" ]
            ]
        ]


blockquote : String -> Html msg
blockquote intention =
    div [ class "dg-pomodoro-intention" ] [ span [] [ text "Intention" ], p [] [ text intention ] ]


small : String -> Html msg
small hint =
    span [ class "dg-pomodoro-hint" ] [ text hint ]



-- HISTORY


historyView : Model -> Html Msg
historyView model =
    let
        sessions =
            scopedSessions model

        total list =
            List.map .focusedMinutes list |> List.sum

        today =
            List.filter (\session -> session.day == model.state.today) sessions

        week =
            List.filter (\session -> session.day >= model.state.weekStart) sessions

        shown =
            List.take model.historyLimit sessions

        days =
            groupByDay shown

        scopeTitle =
            case ( model.scope, scopeProjectId model |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects) ) of
                ( ThisProject, Just project ) ->
                    project.title

                _ ->
                    "All Projects"
    in
    section [ class "dg-pomodoro-history", attribute "aria-label" "Pomodoro history" ]
        [ div [ class "dg-pomodoro-history-heading" ]
            [ h3 [] [ text "History" ]
            , div [ class "dg-pomodoro-scope", attribute "role" "group", attribute "aria-label" "Show sessions for" ]
                [ scopeButton model ThisProject "This Project" (scopeProjectId model == Nothing)
                , scopeButton model AllProjects "All Projects" False
                ]
            ]
        , div [ class "dg-pomodoro-totals", attribute "aria-label" ("Totals for " ++ scopeTitle) ]
            [ totalTile "Today" today (total today)
            , totalTile "This week" week (total week)
            , totalTile "All time" sessions (total sessions)
            ]
        , if List.isEmpty sessions then
            p [ class "dg-muted" ] [ text "No finished sessions yet." ]

          else
            div [ class "dg-pomodoro-days" ] (List.map (dayView model) days)
        , if List.length sessions > model.historyLimit then
            button [ class "dg-pomodoro-more", onClick ShowMore ] [ text "Show more" ]

          else
            text ""
        ]


scopeButton : Model -> Scope -> String -> Bool -> Html Msg
scopeButton model scope caption unavailable =
    let
        active =
            model.scope == scope && not unavailable
    in
    button
        [ classList [ ( "is-active", active ) ]
        , attribute "aria-pressed" (Ui.boolAttribute active)
        , disabled unavailable
        , onClick (SetScope scope)
        ]
        [ text caption ]


totalTile : String -> List Session -> Int -> Html msg
totalTile caption sessions minutes =
    div [ class "dg-pomodoro-total" ]
        [ span [] [ text caption ]
        , strong [] [ text (duration minutes) ]
        , span [] [ text (Ui.plural (List.length sessions) "session") ]
        ]


duration : Int -> String
duration minutes =
    if minutes < 60 then
        String.fromInt minutes ++ " min"

    else
        String.fromInt (minutes // 60) ++ " h " ++ String.fromInt (modBy 60 minutes) ++ " min"


{-| Sessions arrive newest first, so consecutive runs share a day.
-}
groupByDay : List Session -> List ( String, List Session )
groupByDay sessions =
    List.foldr
        (\session groups ->
            case groups of
                ( day, members ) :: rest ->
                    if day == session.day then
                        ( day, session :: members ) :: rest

                    else
                        ( session.day, [ session ] ) :: groups

                [] ->
                    [ ( session.day, [ session ] ) ]
        )
        []
        sessions


dayView : Model -> ( String, List Session ) -> Html Msg
dayView model ( day, sessions ) =
    div [ class "dg-pomodoro-day" ]
        [ div [ class "dg-pomodoro-day-heading" ]
            [ strong []
                [ text
                    (if day == model.state.today then
                        "Today"

                     else
                        day
                    )
                ]
            , span [] [ text (duration (List.map .focusedMinutes sessions |> List.sum)) ]
            ]
        , div [] (List.map (sessionView model) sessions)
        ]


sessionView : Model -> Session -> Html Msg
sessionView model session =
    article [ class "dg-pomodoro-session" ]
        [ span [ class "dg-pomodoro-session-time" ] [ text (session.startedTime ++ "–" ++ session.endedTime) ]
        , div [ class "dg-pomodoro-session-main" ]
            [ span [ class "dg-pomodoro-session-intention" ] [ text session.intention ]
            , div [ class "dg-pomodoro-session-meta" ]
                (List.concat
                    [ if model.scope == AllProjects || scopeProjectId model == Nothing then
                        [ if Data.findProject session.projectId model.snapshot.projects /= Nothing then
                            button [ class "dg-flat-button dg-pomodoro-project-link", title session.projectPath, onClick (Send (Command.ShowProject session.projectId)) ]
                                [ text session.projectTitle ]

                          else
                            span [ title "This Project no longer exists" ] [ text session.projectTitle ]
                        ]

                      else
                        []
                    , [ span [] [ text (String.fromInt session.focusedMinutes ++ " min") ] ]
                    , Ui.maybeList session.outcome (\outcome -> span [ class ("dg-pomodoro-outcome-" ++ Outcome.key outcome) ] [ text (Outcome.symbol outcome ++ " " ++ Outcome.label outcome) ])
                    , if session.stoppedEarly then
                        [ span [] [ text "Finished early" ] ]

                      else
                        []
                    , if session.completedActions > 0 then
                        [ span [] [ text (Ui.plural session.completedActions "Action" ++ " done") ] ]

                      else
                        []
                    ]
                )
            , if String.isEmpty session.reflection then
                text ""

              else
                p [ class "dg-pomodoro-session-reflection" ] [ text session.reflection ]
            ]
        ]



-- DECODING


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map4 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "pomodoro" stateDecoder)
        (Decode.field "initialProjectId" (Decode.maybe Decode.string))
        (Decode.field "nowMs" Decode.int)


stateDecoder : Decoder PomodoroState
stateDecoder =
    Decode.map5 PomodoroState
        (Decode.field "focusMinutes" Decode.int)
        (Decode.field "active" (Decode.nullable activeDecoder))
        (Decode.field "sessions" (Decode.list sessionDecoder))
        (Decode.field "today" Decode.string)
        (Decode.field "weekStart" Decode.string)


activeDecoder : Decoder Active
activeDecoder =
    Decode.succeed Active
        |> andMap (Decode.field "id" Decode.string)
        |> andMap (Decode.field "projectId" Decode.string)
        |> andMap (Decode.field "projectTitle" Decode.string)
        |> andMap (Decode.field "intention" Decode.string)
        |> andMap (Decode.field "focusActionIds" (Decode.list Decode.string))
        |> andMap (Decode.field "completedActionIds" (Decode.list Decode.string))
        |> andMap (Decode.field "plannedMinutes" Decode.int)
        |> andMap (Decode.field "focusedBefore" Decode.float)
        |> andMap (Decode.field "resumedAtMs" (Decode.nullable Decode.int))
        |> andMap (Decode.field "startedTime" Decode.string)


sessionDecoder : Decoder Session
sessionDecoder =
    Decode.succeed Session
        |> andMap (Decode.field "id" Decode.string)
        |> andMap (Decode.field "projectId" Decode.string)
        |> andMap (Decode.field "projectTitle" Decode.string)
        |> andMap (Decode.field "projectPath" Decode.string)
        |> andMap (Decode.field "intention" Decode.string)
        |> andMap (Decode.field "day" Decode.string)
        |> andMap (Decode.field "startedTime" Decode.string)
        |> andMap (Decode.field "endedTime" Decode.string)
        |> andMap (Decode.field "focusedMinutes" Decode.int)
        |> andMap (Decode.field "status" Decode.string |> Decode.map ((==) "stopped"))
        |> andMap (Decode.field "outcome" (Decode.nullable Outcome.decoder))
        |> andMap (Decode.field "reflection" Decode.string)
        |> andMap (Decode.field "completedActions" Decode.int)


andMap : Decoder a -> Decoder (a -> b) -> Decoder b
andMap =
    Decode.map2 (|>)


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "pomodoro" ->
                        Decode.map StateEvent (Decode.field "pomodoro" stateDecoder)

                    "select-project" ->
                        Decode.map SelectProjectEvent (Decode.field "projectId" Decode.string)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
