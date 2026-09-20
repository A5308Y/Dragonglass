port module ActionBoard exposing (main)

import Browser
import Browser.Dom
import Dict exposing (Dict)
import Html exposing (Html, article, button, div, h2, header, input, label, option, section, select, span, text)
import Html.Attributes exposing (attribute, checked, class, classList, disabled, draggable, id, placeholder, selected, tabindex, title, type_, value)
import Html.Events exposing (custom, on, onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
import Task


port toHost : Encode.Value -> Cmd msg


port fromHost : (Decode.Value -> msg) -> Sub msg


protocolVersion : Int
protocolVersion =
    1


type alias File =
    { path : String, name : String, basename : String, extension : String }


type alias Action =
    { id : String
    , title : String
    , file : File
    , status : String
    , created : String
    , projectId : Maybe String
    , context : Maybe String
    , energy : Maybe String
    , due : Maybe String
    , deferUntil : Maybe String
    , waitingSince : Maybe String
    , scheduledStart : Maybe String
    , durationMinutes : Maybe Int
    , work : Bool
    }


type alias Project =
    { id : String, title : String, status : String, parentProjectId : Maybe String }


type Filter
    = ValueFilter String String (List String)
    | DueFilter String (Maybe DueValue)
    | AvailabilityFilter
    | WorkFilter Bool


type DueValue
    = DateValue String
    | DaysValue Int


type alias SortSpec =
    { field : String, direction : String }


type alias Configuration =
    { filters : List Filter
    , groupBy : String
    , sort : SortSpec
    , visibleColumns : Maybe (List String)
    }


type alias SavedView =
    { id : String
    , name : String
    , configuration : Configuration
    }


type alias GoogleCalendarSettings =
    { enabled : Bool
    , endpointUrl : String
    , sharedSecret : String
    , sourceId : String
    , defaultDurationMinutes : Int
    }


type alias Settings =
    { inboxDirectory : String
    , referenceDirectory : String
    , projectsDirectory : String
    , actionsDirectory : String
    , defaultProjectImage : String
    , showProjectBoardImages : Bool
    , defaultActionStatus : String
    , showDoneColumn : Bool
    , projectBoardColumns : List String
    , savedViews : List SavedView
    , activeSavedViewId : Maybe String
    , googleCalendar : GoogleCalendarSettings
    , schemaVersion : Int
    }


type alias Issue =
    { path : String, message : String }


type alias Snapshot =
    { revision : Int
    , today : String
    , actions : List Action
    , projects : List Project
    , issues : List Issue
    , settings : Settings
    }


type alias Group =
    { key : String, label : String, actions : List Action }


type alias Pending =
    { actionId : String, status : String }


type alias Model =
    { snapshot : Snapshot
    , activeViewId : Maybe String
    , configuration : Configuration
    , search : String
    , filterOpen : Bool
    , columnsOpen : Bool
    , filterField : String
    , filterOperator : String
    , filterValue : String
    , dueOperator : String
    , dueValue : String
    , dragged : Maybe String
    , optimistic : Dict String String
    , pending : Dict String Pending
    , promptRequests : Dict String Bool
    , nextRequest : Int
    , fatalError : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | SearchChanged String
    | ToggleFilters
    | ToggleColumns
    | SelectSavedView String
    | SetGroupBy String
    | SetSortField String
    | ReverseSort
    | SaveView
    | SaveViewAs
    | DeleteView
    | SetFilterField String
    | SetFilterOperator String
    | SetFilterValue String
    | SetDueOperator String
    | SetDueValue String
    | AddFilter
    | RemoveFilter Int
    | ToggleColumn String
    | DragStarted String
    | DragOver
    | DropOn String
    | CardKey String String
    | Focused (Result Browser.Dom.Error ())
    | HostCommand (Maybe Pending) Encode.Value
    | OpenMenu Float Float Action


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> fromHost GotHost
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue snapshotDecoder flags of
        Ok snapshot ->
            let
                active =
                    snapshot.settings.activeSavedViewId

                configuration =
                    active
                        |> Maybe.andThen (findSavedView snapshot.settings.savedViews)
                        |> Maybe.map .configuration
                        |> Maybe.withDefault (defaultConfiguration snapshot.settings)
            in
            ( initialModel snapshot active configuration, Cmd.none )

        Err error ->
            let
                fallback =
                    emptySnapshot

                fallbackModel =
                    initialModel fallback Nothing (defaultConfiguration fallback.settings)
            in
            ( { fallbackModel | fatalError = Just (Decode.errorToString error) }, Cmd.none )


initialModel : Snapshot -> Maybe String -> Configuration -> Model
initialModel snapshot active configuration =
    { snapshot = snapshot
    , activeViewId = active
    , configuration = configuration
    , search = ""
    , filterOpen = False
    , columnsOpen = False
    , filterField = "status"
    , filterOperator = "in"
    , filterValue = "next"
    , dueOperator = "onOrBefore"
    , dueValue = snapshot.today
    , dragged = Nothing
    , optimistic = Dict.empty
    , pending = Dict.empty
    , promptRequests = Dict.empty
    , nextRequest = 1
    , fatalError = Nothing
    }


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value_ ->
            receiveHost value_ model

        SearchChanged query ->
            ( { model | search = query }, Cmd.none )

        ToggleFilters ->
            ( { model | filterOpen = not model.filterOpen }, Cmd.none )

        ToggleColumns ->
            ( { model | columnsOpen = not model.columnsOpen }, Cmd.none )

        SelectSavedView savedId ->
            let
                selected =
                    findSavedView model.snapshot.settings.savedViews savedId

                nextId =
                    if String.isEmpty savedId then
                        Nothing

                    else
                        Just savedId

                configuration =
                    Maybe.map .configuration selected |> Maybe.withDefault (defaultConfiguration model.snapshot.settings)

                settings =
                    model.snapshot.settings

                nextSettings =
                    { settings | activeSavedViewId = nextId }
            in
            issue Nothing (saveSettingsCommand nextSettings) { model | activeViewId = nextId, configuration = configuration }

        SetGroupBy groupBy ->
            ( { model | configuration = updateConfiguration model.configuration groupBy }, Cmd.none )

        SetSortField field ->
            let
                config =
                    model.configuration

                sort_ =
                    config.sort
            in
            ( { model | configuration = { config | sort = { sort_ | field = field } } }, Cmd.none )

        ReverseSort ->
            let
                config =
                    model.configuration

                sort_ =
                    config.sort

                direction =
                    if sort_.direction == "asc" then
                        "desc"

                    else
                        "asc"
            in
            ( { model | configuration = { config | sort = { sort_ | direction = direction } } }, Cmd.none )

        SaveView ->
            case model.activeViewId of
                Just _ ->
                    saveCurrentView model

                Nothing ->
                    promptForView False model

        SaveViewAs ->
            promptForView True model

        DeleteView ->
            deleteCurrentView model

        SetFilterField field ->
            ( { model
                | filterField = field
                , filterValue =
                    if field == "status" then
                        "next"

                    else
                        ""
              }
            , Cmd.none
            )

        SetFilterOperator operator ->
            ( { model | filterOperator = operator }, Cmd.none )

        SetFilterValue next ->
            ( { model | filterValue = next }, Cmd.none )

        SetDueOperator operator ->
            ( { model
                | dueOperator = operator
                , dueValue =
                    if operator == "withinNextDays" then
                        "7"

                    else
                        model.snapshot.today
              }
            , Cmd.none
            )

        SetDueValue next ->
            ( { model | dueValue = next }, Cmd.none )

        AddFilter ->
            let
                filter =
                    newFilter model

                config =
                    model.configuration
            in
            ( { model | configuration = { config | filters = config.filters ++ [ filter ] } }, Cmd.none )

        RemoveFilter index_ ->
            let
                config =
                    model.configuration
            in
            ( { model | configuration = { config | filters = removeAt index_ config.filters } }, Cmd.none )

        ToggleColumn key ->
            let
                config =
                    model.configuration

                candidates =
                    columnCandidates model

                visible =
                    Set.fromList (Maybe.withDefault candidates config.visibleColumns)

                next =
                    if Set.member key visible then
                        Set.remove key visible

                    else
                        Set.insert key visible
            in
            ( { model | configuration = { config | visibleColumns = Just (Set.toList next) } }, Cmd.none )

        DragStarted actionId ->
            ( { model | dragged = Just actionId }, Cmd.none )

        DragOver ->
            ( model, Cmd.none )

        DropOn status ->
            case model.dragged of
                Just actionId ->
                    moveAction actionId status { model | dragged = Nothing }

                Nothing ->
                    ( model, Cmd.none )

        CardKey actionId key ->
            if String.toLower key == "d" then
                moveAction actionId "done" model

            else if key == "ArrowDown" || key == "ArrowUp" then
                let
                    ids =
                        visibleActionIds model

                    target =
                        adjacent key actionId ids
                in
                ( model, Maybe.map (\next -> Browser.Dom.focus (cardDomId next) |> Task.attempt Focused) target |> Maybe.withDefault Cmd.none )

            else
                ( model, Cmd.none )

        Focused _ ->
            ( model, Cmd.none )

        HostCommand pending command ->
            issue pending command model

        OpenMenu x y action ->
            issue Nothing (menuCommand x y model action) model


updateConfiguration : Configuration -> String -> Configuration
updateConfiguration config groupBy =
    { config | groupBy = groupBy, visibleColumns = Nothing }


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value_ model =
    case Decode.decodeValue hostEventDecoder value_ of
        Ok (SnapshotEvent snapshot) ->
            let
                converged pending =
                    List.any (\action -> action.id == pending.actionId && action.status == pending.status) snapshot.actions

                remainingPending =
                    Dict.filter (\_ pending -> not (converged pending)) model.pending

                optimistic =
                    remainingPending |> Dict.values |> List.map (\pending -> ( pending.actionId, pending.status )) |> Dict.fromList
            in
            ( { model | snapshot = snapshot, pending = remainingPending, optimistic = optimistic, fatalError = Nothing }, Cmd.none )

        Ok (CommandResult requestId succeeded error resultValue) ->
            if succeeded then
                case ( Dict.get requestId model.promptRequests, resultValue ) of
                    ( Just _, Just name ) ->
                        createSavedView name { model | promptRequests = Dict.remove requestId model.promptRequests }

                    _ ->
                        ( model, Cmd.none )

            else
                let
                    pending =
                        Dict.remove requestId model.pending

                    optimistic =
                        pending |> Dict.values |> List.map (\item -> ( item.actionId, item.status )) |> Dict.fromList
                in
                ( { model | pending = pending, optimistic = optimistic, fatalError = error }, Cmd.none )

        Err error ->
            ( { model | fatalError = Just (Decode.errorToString error) }, Cmd.none )


type HostEvent
    = SnapshotEvent Snapshot
    | CommandResult String Bool (Maybe String) (Maybe String)


issue : Maybe Pending -> Encode.Value -> Model -> ( Model, Cmd Msg )
issue pending command model =
    let
        requestId =
            "elm-" ++ String.fromInt model.nextRequest

        nextPending =
            Maybe.map (\item -> Dict.insert requestId item model.pending) pending |> Maybe.withDefault model.pending

        optimistic =
            Maybe.map (\item -> Dict.insert item.actionId item.status model.optimistic) pending |> Maybe.withDefault model.optimistic

        envelope =
            Encode.object [ ( "protocolVersion", Encode.int protocolVersion ), ( "requestId", Encode.string requestId ), ( "command", command ) ]
    in
    ( { model | nextRequest = model.nextRequest + 1, pending = nextPending, optimistic = optimistic }, toHost envelope )


moveAction : String -> String -> Model -> ( Model, Cmd Msg )
moveAction actionId status model =
    case findAction actionId model.snapshot.actions of
        Just action ->
            if action.status == status then
                ( model, Cmd.none )

            else
                issue
                    (if status == "scheduled" && not (hasSchedule action) then
                        Nothing

                     else
                        Just { actionId = actionId, status = status }
                    )
                    (Encode.object [ ( "type", Encode.string "set-action-status" ), ( "actionId", Encode.string actionId ), ( "status", Encode.string status ) ])
                    model

        Nothing ->
            ( model, Cmd.none )


saveCurrentView : Model -> ( Model, Cmd Msg )
saveCurrentView model =
    case model.activeViewId of
        Nothing ->
            promptForView False model

        Just activeId ->
            let
                settings =
                    model.snapshot.settings

                views =
                    List.map
                        (\saved ->
                            if saved.id == activeId then
                                { saved | configuration = model.configuration }

                            else
                                saved
                        )
                        settings.savedViews
            in
            issue Nothing (saveSettingsCommand { settings | savedViews = views }) model


promptForView : Bool -> Model -> ( Model, Cmd Msg )
promptForView saveAs model =
    let
        requestId =
            "elm-" ++ String.fromInt model.nextRequest

        activeName =
            model.activeViewId |> Maybe.andThen (findSavedView model.snapshot.settings.savedViews) |> Maybe.map .name

        placeholder_ =
            if saveAs then
                Maybe.map ((++) " copy") activeName |> Maybe.withDefault "View name"

            else
                "View name"

        command =
            Encode.object
                [ ( "type", Encode.string "prompt" )
                , ( "title"
                  , Encode.string
                        (if saveAs then
                            "Save board view as"

                         else
                            "Save board view"
                        )
                  )
                , ( "placeholder", Encode.string placeholder_ )
                ]

        envelope =
            Encode.object [ ( "protocolVersion", Encode.int protocolVersion ), ( "requestId", Encode.string requestId ), ( "command", command ) ]
    in
    ( { model | nextRequest = model.nextRequest + 1, promptRequests = Dict.insert requestId saveAs model.promptRequests }, toHost envelope )


createSavedView : String -> Model -> ( Model, Cmd Msg )
createSavedView name model =
    let
        viewId =
            "view-" ++ String.fromInt model.snapshot.revision ++ "-" ++ String.fromInt model.nextRequest

        saved =
            { id = viewId, name = name, configuration = model.configuration }

        settings =
            model.snapshot.settings

        nextSettings =
            { settings | savedViews = settings.savedViews ++ [ saved ], activeSavedViewId = Just viewId }
    in
    issue Nothing (saveSettingsCommand nextSettings) { model | activeViewId = Just viewId }


deleteCurrentView : Model -> ( Model, Cmd Msg )
deleteCurrentView model =
    case model.activeViewId of
        Nothing ->
            ( model, Cmd.none )

        Just activeId ->
            let
                settings =
                    model.snapshot.settings

                nextSettings =
                    { settings | savedViews = List.filter (\saved -> saved.id /= activeId) settings.savedViews, activeSavedViewId = Nothing }
            in
            issue Nothing (saveSettingsCommand nextSettings) { model | activeViewId = Nothing, configuration = defaultConfiguration settings }


view : Model -> Html Msg
view model =
    case model.fatalError of
        Just error ->
            div [ class "dg-view dg-board-view" ]
                [ div [ class "dg-warning" ] [ text ("Elm adapter error: " ++ error) ]
                , boardView model
                ]

        Nothing ->
            boardView model


boardView : Model -> Html Msg
boardView model =
    let
        groups =
            buildGroups model
    in
    div [ class "dg-view dg-board-view" ]
        [ header [ class "dg-view-header" ]
            [ div [] [ h2 [] [ text "Actions" ], span [ class "dg-count" ] [ text (String.fromInt (List.length model.snapshot.actions)) ] ]
            , div [ class "dg-header-actions" ]
                [ button [ class "mod-cta", onClick (HostCommand Nothing (simpleCommand "create-action")) ] [ text "New Action" ]
                , button [ onClick (HostCommand Nothing (simpleCommand "quick-capture")) ] [ text "Quick Capture" ]
                , button [ onClick (HostCommand Nothing (simpleCommand "open-inbox")) ] [ text "Open Inbox" ]
                ]
            ]
        , issuesView model.snapshot.issues
        , toolbar model
        , if model.filterOpen then
            filterBuilder model

          else
            text ""
        , if model.columnsOpen then
            columnPicker model

          else
            text ""
        , filterChips model
        , div [ class "dg-board", attribute "role" "list" ]
            (if List.isEmpty groups then
                [ div [ class "dg-empty" ] [ text "No Actions match this view." ] ]

             else
                List.map (groupView model) groups
            )
        ]


issuesView : List Issue -> Html Msg
issuesView issues =
    if List.isEmpty issues then
        text ""

    else
        div [ class "dg-warning", title (String.join "\n" (List.map (\problem -> problem.path ++ ": " ++ problem.message) issues)) ]
            [ text (String.fromInt (List.length issues) ++ " GTD files have metadata problems.") ]


toolbar : Model -> Html Msg
toolbar model =
    div [ class "dg-toolbar" ]
        [ select [ attribute "aria-label" "Saved view", onInput SelectSavedView ]
            (option [ value "", selected (model.activeViewId == Nothing) ] [ text "Board" ]
                :: List.map (\saved -> option [ value saved.id, selected (model.activeViewId == Just saved.id) ] [ text saved.name ]) model.snapshot.settings.savedViews
            )
        , input [ type_ "search", placeholder "Search Actions or Projects", value model.search, onInput SearchChanged ] []
        , button [ classList [ ( "is-active", model.filterOpen ) ], onClick ToggleFilters ] [ text "Filter" ]
        , select [ attribute "aria-label" "Group by", value model.configuration.groupBy, onInput SetGroupBy ]
            [ option [ value "status" ] [ text "Group: Status" ]
            , option [ value "project" ] [ text "Group: Project" ]
            , option [ value "context" ] [ text "Group: Context" ]
            , option [ value "energy" ] [ text "Group: Energy" ]
            ]
        , select [ attribute "aria-label" "Sort by", value model.configuration.sort.field, onInput SetSortField ]
            [ option [ value "created" ] [ text "Sort: Created" ]
            , option [ value "due" ] [ text "Sort: Due" ]
            , option [ value "title" ] [ text "Sort: Title" ]
            , option [ value "project" ] [ text "Sort: Project" ]
            ]
        , button [ attribute "aria-label" "Reverse sort", onClick ReverseSort ]
            [ text
                (if model.configuration.sort.direction == "asc" then
                    "↑"

                 else
                    "↓"
                )
            ]
        , button [ classList [ ( "is-active", model.columnsOpen ) ], onClick ToggleColumns ] [ text "Columns" ]
        , button [ onClick SaveView ] [ text "Save" ]
        , button [ onClick SaveViewAs ] [ text "Save As" ]
        , if model.activeViewId /= Nothing then
            button [ attribute "aria-label" "Delete saved view", onClick DeleteView ] [ text "Delete" ]

          else
            text ""
        ]


filterBuilder : Model -> Html Msg
filterBuilder model =
    let
        values =
            filterValues model

        valueControl =
            if List.member model.filterField [ "due", "available", "work" ] then
                text ""

            else
                select [ value model.filterValue, onInput SetFilterValue ] (List.map (\( key, name ) -> option [ value key ] [ text name ]) values)
    in
    div [ class "dg-panel dg-filter-builder" ]
        [ select [ value model.filterField, onInput SetFilterField ]
            [ option [ value "status" ] [ text "Status" ]
            , option [ value "project" ] [ text "Project" ]
            , option [ value "context" ] [ text "Context" ]
            , option [ value "energy" ] [ text "Energy" ]
            , option [ value "due" ] [ text "Due date" ]
            , option [ value "available" ] [ text "Available now" ]
            , option [ value "work" ] [ text "Work" ]
            ]
        , if List.member model.filterField [ "due", "available" ] then
            text ""

          else
            select [ value model.filterOperator, onInput SetFilterOperator ] [ option [ value "in" ] [ text "is" ], option [ value "notIn" ] [ text "is not" ] ]
        , valueControl
        , if model.filterField == "due" then
            dueControls model

          else
            text ""
        , button [ class "mod-cta", onClick AddFilter ] [ text "Add filter" ]
        ]


dueControls : Model -> Html Msg
dueControls model =
    span []
        [ select [ value model.dueOperator, onInput SetDueOperator ]
            [ option [ value "before" ] [ text "before" ]
            , option [ value "onOrBefore" ] [ text "on or before" ]
            , option [ value "after" ] [ text "after" ]
            , option [ value "onOrAfter" ] [ text "on or after" ]
            , option [ value "withinNextDays" ] [ text "within next days" ]
            , option [ value "isEmpty" ] [ text "is empty" ]
            , option [ value "isNotEmpty" ] [ text "is not empty" ]
            ]
        , if List.member model.dueOperator [ "isEmpty", "isNotEmpty" ] then
            text ""

          else
            input
                [ type_
                    (if model.dueOperator == "withinNextDays" then
                        "number"

                     else
                        "date"
                    )
                , value model.dueValue
                , onInput SetDueValue
                ]
                []
        ]


filterChips : Model -> Html Msg
filterChips model =
    if List.isEmpty model.configuration.filters then
        text ""

    else
        div [ class "dg-filter-chips" ]
            (List.indexedMap (\index_ filter -> button [ class "dg-chip", onClick (RemoveFilter index_) ] [ text (describeFilter model filter ++ " ×") ]) model.configuration.filters)


columnPicker : Model -> Html Msg
columnPicker model =
    let
        candidates =
            columnCandidates model

        visible =
            Set.fromList (Maybe.withDefault candidates model.configuration.visibleColumns)
    in
    div [ class "dg-panel dg-column-picker" ]
        (List.map (\key -> label [] [ input [ type_ "checkbox", checked (Set.member key visible), onCheck (\_ -> ToggleColumn key) ] [], text (" " ++ displayLabel key) ]) candidates)


groupView : Model -> Group -> Html Msg
groupView model group =
    let
        canDrop =
            model.configuration.groupBy == "status" && List.member group.key [ "next", "waiting", "scheduled", "done" ]
    in
    section
        ([ class "dg-column", attribute "data-column" group.key ]
            ++ (if canDrop then
                    [ preventDefault "dragover" DragOver, preventDefault "drop" (DropOn group.key) ]

                else
                    []
               )
        )
        [ header [ class "dg-column-header" ] [ span [] [ text group.label ], span [] [ text (String.fromInt (List.length group.actions)) ] ]
        , div [ class "dg-card-list" ] (List.map (cardView model) group.actions)
        ]


cardView : Model -> Action -> Html Msg
cardView model action =
    let
        project =
            action.projectId |> Maybe.andThen (\projectId -> findProject projectId model.snapshot.projects)

        breadcrumb =
            Maybe.map (projectBreadcrumb model.snapshot.projects) project

        overdue =
            Maybe.map (\due -> due < model.snapshot.today && action.status /= "done") action.due |> Maybe.withDefault False

        schedule =
            scheduleText action
    in
    article
        [ class "dg-card"
        , attribute "role" "listitem"
        , attribute "data-card" action.id
        , id (cardDomId action.id)
        , tabindex 0
        , draggable "true"
        , on "dragstart" (Decode.succeed (DragStarted action.id))
        , on "keydown" (Decode.field "key" Decode.string |> Decode.map (CardKey action.id))
        ]
        [ div [ class "dg-card-title-row" ]
            [ span [ class "dg-card-title dg-action-card-title", title action.title ] [ text action.title ]
            , button
                [ class "dg-icon-button"
                , attribute "aria-label" ("Actions for " ++ action.title)
                , on "click" (Decode.map2 (\x y -> OpenMenu x y action) (Decode.field "clientX" Decode.float) (Decode.field "clientY" Decode.float))
                ]
                [ text "•••" ]
            ]
        , case ( action.projectId, breadcrumb ) of
            ( Just _, Just name ) ->
                button [ class "dg-project-link", title name, onClick (HostCommand Nothing (showProjectCommand (Maybe.withDefault "" action.projectId))) ] [ text name ]

            ( Just _, Nothing ) ->
                span [ class "dg-missing" ] [ text "Missing project" ]

            _ ->
                text ""
        , div [ class "dg-card-meta" ]
            [ maybeSpan (Maybe.map ((++) "@") action.context)
            , maybeSpan action.energy
            , case action.due of
                Just due ->
                    span [ classList [ ( "is-overdue", overdue ) ] ] [ text due ]

                Nothing ->
                    text ""
            , if action.status == "waiting" then
                span [] [ text ("Waiting since " ++ Maybe.withDefault "—" action.waitingSince) ]

              else
                text ""
            , maybeSpan schedule
            ]
        ]


maybeSpan : Maybe String -> Html msg
maybeSpan maybeText =
    Maybe.map (\value_ -> span [] [ text value_ ]) maybeText |> Maybe.withDefault (text "")


preventDefault : String -> msg -> Html.Attribute msg
preventDefault eventName message =
    custom eventName (Decode.succeed { message = message, stopPropagation = False, preventDefault = True })


buildGroups : Model -> List Group
buildGroups model =
    let
        actions =
            model.snapshot.actions
                |> List.map (\action -> { action | status = Dict.get action.id model.optimistic |> Maybe.withDefault action.status })
                |> List.filter (matchesAll model)
                |> sortActions model

        grouped =
            List.foldl
                (\action groups ->
                    let
                        key =
                            groupKey model action
                    in
                    Dict.update key (\existing -> Just (action :: Maybe.withDefault [] existing)) groups
                )
                Dict.empty
                actions

        keys =
            if model.configuration.groupBy == "status" then
                Maybe.withDefault (statusColumns model.snapshot.settings) model.configuration.visibleColumns

            else
                Dict.keys grouped |> applyVisible model.configuration.visibleColumns
    in
    List.map (\key -> { key = key, label = groupLabel model key, actions = Dict.get key grouped |> Maybe.withDefault [] |> List.reverse }) keys


matchesAll : Model -> Action -> Bool
matchesAll model action =
    let
        query =
            String.toLower (String.trim model.search)

        projectText =
            action.projectId |> Maybe.andThen (\id_ -> findProject id_ model.snapshot.projects) |> Maybe.map (projectBreadcrumb model.snapshot.projects) |> Maybe.withDefault ""

        searched =
            String.isEmpty query || String.contains query (String.toLower action.title) || String.contains query (String.toLower projectText)
    in
    searched && List.all (matchesFilter model action) model.configuration.filters


matchesFilter : Model -> Action -> Filter -> Bool
matchesFilter model action filter =
    case filter of
        ValueFilter field operator values ->
            let
                actual =
                    case field of
                        "status" ->
                            action.status

                        "project" ->
                            Maybe.withDefault "" action.projectId

                        "context" ->
                            Maybe.withDefault "" action.context

                        "energy" ->
                            Maybe.withDefault "" action.energy

                        _ ->
                            ""

                contains =
                    List.member actual values
            in
            if operator == "in" then
                contains

            else
                not contains

        AvailabilityFilter ->
            Maybe.map (\date -> date <= model.snapshot.today) action.deferUntil |> Maybe.withDefault True

        WorkFilter expected ->
            action.work == expected

        DueFilter operator dueValue ->
            case ( operator, action.due, dueValue ) of
                ( "isEmpty", Nothing, _ ) ->
                    True

                ( "isNotEmpty", Just _, _ ) ->
                    True

                ( "before", Just due, Just (DateValue expected) ) ->
                    due < expected

                ( "onOrBefore", Just due, Just (DateValue expected) ) ->
                    due <= expected

                ( "after", Just due, Just (DateValue expected) ) ->
                    due > expected

                ( "onOrAfter", Just due, Just (DateValue expected) ) ->
                    due >= expected

                ( "withinNextDays", Just due, Just (DaysValue days) ) ->
                    due >= model.snapshot.today && due <= addDays model.snapshot.today days

                _ ->
                    False


sortActions : Model -> List Action -> List Action
sortActions model actions =
    let
        key action =
            case model.configuration.sort.field of
                "due" ->
                    Maybe.withDefault "9999-99-99" action.due

                "title" ->
                    String.toLower action.title

                "project" ->
                    action.projectId |> Maybe.andThen (\id_ -> findProject id_ model.snapshot.projects) |> Maybe.map (projectBreadcrumb model.snapshot.projects >> String.toLower) |> Maybe.withDefault "zzzz"

                _ ->
                    action.created

        compareActions left right =
            if model.configuration.sort.field == "due" then
                case ( left.due, right.due ) of
                    ( Nothing, Nothing ) ->
                        compare left.id right.id

                    ( Nothing, Just _ ) ->
                        GT

                    ( Just _, Nothing ) ->
                        LT

                    ( Just leftDue, Just rightDue ) ->
                        if model.configuration.sort.direction == "desc" then
                            compare ( rightDue, right.id ) ( leftDue, left.id )

                        else
                            compare ( leftDue, left.id ) ( rightDue, right.id )

            else if model.configuration.sort.direction == "desc" then
                compare ( key right, right.id ) ( key left, left.id )

            else
                compare ( key left, left.id ) ( key right, right.id )
    in
    List.sortWith compareActions actions


groupKey : Model -> Action -> String
groupKey model action =
    case model.configuration.groupBy of
        "project" ->
            Maybe.withDefault "" action.projectId

        "context" ->
            Maybe.withDefault "" action.context

        "energy" ->
            Maybe.withDefault "" action.energy

        _ ->
            action.status


groupLabel : Model -> String -> String
groupLabel model key =
    if model.configuration.groupBy == "project" then
        if String.isEmpty key then
            "No project"

        else
            findProject key model.snapshot.projects |> Maybe.map (projectBreadcrumb model.snapshot.projects) |> Maybe.withDefault "Missing project"

    else if String.isEmpty key then
        "No " ++ model.configuration.groupBy

    else
        displayLabel key


columnCandidates : Model -> List String
columnCandidates model =
    if model.configuration.groupBy == "status" then
        statusColumns model.snapshot.settings

    else
        let
            config =
                model.configuration

            allColumnsModel =
                { model | configuration = { config | visibleColumns = Nothing } }
        in
        buildGroups allColumnsModel |> List.map .key


filterValues : Model -> List ( String, String )
filterValues model =
    case model.filterField of
        "status" ->
            List.map (\status -> ( status, displayLabel status )) [ "next", "waiting", "scheduled", "done", "cancelled" ]

        "project" ->
            ( "", "No project" ) :: (model.snapshot.projects |> List.map (\project -> ( project.id, projectBreadcrumb model.snapshot.projects project )) |> List.sortBy Tuple.second)

        "context" ->
            uniqueSorted (List.filterMap .context model.snapshot.actions) |> List.map (\item -> ( item, item ))

        "energy" ->
            uniqueSorted (List.filterMap .energy model.snapshot.actions) |> List.map (\item -> ( item, item ))

        _ ->
            []


newFilter : Model -> Filter
newFilter model =
    case model.filterField of
        "available" ->
            AvailabilityFilter

        "work" ->
            WorkFilter (model.filterOperator == "in")

        "due" ->
            if model.dueOperator == "withinNextDays" then
                DueFilter model.dueOperator (Just (DaysValue (String.toInt model.dueValue |> Maybe.withDefault 7)))

            else if List.member model.dueOperator [ "isEmpty", "isNotEmpty" ] then
                DueFilter model.dueOperator Nothing

            else
                DueFilter model.dueOperator (Just (DateValue model.dueValue))

        field ->
            ValueFilter field model.filterOperator [ model.filterValue ]


describeFilter : Model -> Filter -> String
describeFilter model filter =
    case filter of
        AvailabilityFilter ->
            "Available now"

        WorkFilter True ->
            "Work"

        WorkFilter False ->
            "Not work"

        DueFilter "withinNextDays" (Just (DaysValue days)) ->
            "Due within " ++ String.fromInt days ++ " days"

        DueFilter operator _ ->
            "Due " ++ operator

        ValueFilter field operator values ->
            let
                names =
                    if field == "project" then
                        List.map
                            (\id_ ->
                                if String.isEmpty id_ then
                                    "No project"

                                else
                                    findProject id_ model.snapshot.projects |> Maybe.map (projectBreadcrumb model.snapshot.projects) |> Maybe.withDefault "Missing project"
                            )
                            values

                    else
                        values
            in
            displayLabel field
                ++ (if operator == "in" then
                        " is "

                    else
                        " is not "
                   )
                ++ String.join ", " names


menuCommand : Float -> Float -> Model -> Action -> Encode.Value
menuCommand x y model action =
    let
        statusEntries =
            List.map
                (\status ->
                    menuEntry
                        ((if status == action.status then
                            "✓ "

                          else
                            ""
                         )
                            ++ displayLabel status
                        )
                        (setStatusCommand action.id status)
                )
                [ "next", "waiting", "scheduled", "done", "cancelled" ]

        projects =
            model.snapshot.projects |> List.filter (\project -> not (List.member project.status [ "completed", "cancelled" ])) |> List.sortBy (projectBreadcrumb model.snapshot.projects)

        projectEntries =
            menuEntry "No project" (updateProjectCommand action.id "")
                :: List.map
                    (\project ->
                        menuEntry
                            ((if action.projectId == Just project.id then
                                "✓ "

                              else
                                ""
                             )
                                ++ projectBreadcrumb model.snapshot.projects project
                            )
                            (updateProjectCommand action.id project.id)
                    )
                    projects

        contexts =
            uniqueSorted (List.filterMap .context model.snapshot.actions)

        contextEntries =
            List.map
                (\context ->
                    menuEntry
                        ((if action.context == Just context then
                            "✓ "

                          else
                            ""
                         )
                            ++ "@"
                            ++ context
                        )
                        (updateContextCommand action.id context)
                )
                contexts

        entries =
            statusEntries
                ++ [ separator ]
                ++ projectEntries
                ++ (if List.isEmpty contexts then
                        []

                    else
                        separator :: contextEntries
                   )
                ++ [ separator, menuEntry "Edit…" (editActionCommand action.id), menuEntry "Delete Action…" (trashActionCommand action.id) ]
    in
    Encode.object [ ( "type", Encode.string "show-menu" ), ( "x", Encode.float x ), ( "y", Encode.float y ), ( "entries", Encode.list identity entries ) ]


menuEntry : String -> Encode.Value -> Encode.Value
menuEntry name command =
    Encode.object [ ( "label", Encode.string name ), ( "command", command ) ]


separator : Encode.Value
separator =
    Encode.object [ ( "separator", Encode.bool True ) ]


simpleCommand : String -> Encode.Value
simpleCommand commandType =
    Encode.object [ ( "type", Encode.string commandType ) ]


showProjectCommand : String -> Encode.Value
showProjectCommand projectId =
    Encode.object [ ( "type", Encode.string "show-project" ), ( "projectId", Encode.string projectId ) ]


editActionCommand : String -> Encode.Value
editActionCommand actionId =
    Encode.object [ ( "type", Encode.string "edit-action" ), ( "actionId", Encode.string actionId ) ]


trashActionCommand : String -> Encode.Value
trashActionCommand actionId =
    Encode.object [ ( "type", Encode.string "trash-action" ), ( "actionId", Encode.string actionId ) ]


setStatusCommand : String -> String -> Encode.Value
setStatusCommand actionId status =
    Encode.object [ ( "type", Encode.string "set-action-status" ), ( "actionId", Encode.string actionId ), ( "status", Encode.string status ) ]


updateProjectCommand : String -> String -> Encode.Value
updateProjectCommand actionId projectId =
    Encode.object [ ( "type", Encode.string "update-action" ), ( "actionId", Encode.string actionId ), ( "projectId", Encode.string projectId ) ]


updateContextCommand : String -> String -> Encode.Value
updateContextCommand actionId context =
    Encode.object [ ( "type", Encode.string "update-action" ), ( "actionId", Encode.string actionId ), ( "context", Encode.string context ) ]


saveSettingsCommand : Settings -> Encode.Value
saveSettingsCommand settings =
    Encode.object [ ( "type", Encode.string "save-settings" ), ( "settings", encodeSettings settings ) ]


snapshotDecoder : Decoder Snapshot
snapshotDecoder =
    Decode.map6 Snapshot
        (Decode.field "revision" Decode.int)
        (Decode.field "today" Decode.string)
        (Decode.field "actions" (Decode.list actionDecoder))
        (Decode.field "projects" (Decode.list projectDecoder))
        (Decode.field "issues" (Decode.list issueDecoder))
        (Decode.field "settings" settingsDecoder)


actionDecoder : Decoder Action
actionDecoder =
    Decode.succeed Action
        |> required "id" Decode.string
        |> required "title" Decode.string
        |> required "file" fileDecoder
        |> required "status" Decode.string
        |> required "created" Decode.string
        |> optional "projectId" (Decode.maybe Decode.string) Nothing
        |> optional "context" (Decode.maybe Decode.string) Nothing
        |> optional "energy" (Decode.maybe Decode.string) Nothing
        |> optional "due" (Decode.maybe Decode.string) Nothing
        |> optional "deferUntil" (Decode.maybe Decode.string) Nothing
        |> optional "waitingSince" (Decode.maybe Decode.string) Nothing
        |> optional "scheduledStart" (Decode.maybe Decode.string) Nothing
        |> optional "durationMinutes" (Decode.maybe Decode.int) Nothing
        |> optional "work" Decode.bool False


fileDecoder : Decoder File
fileDecoder =
    Decode.map4 File (Decode.field "path" Decode.string) (Decode.field "name" Decode.string) (Decode.field "basename" Decode.string) (Decode.field "extension" Decode.string)


projectDecoder : Decoder Project
projectDecoder =
    Decode.map4 Project (Decode.field "id" Decode.string) (Decode.field "title" Decode.string) (Decode.field "status" Decode.string) (optionalField "parentProjectId" (Decode.maybe Decode.string) Nothing)


issueDecoder : Decoder Issue
issueDecoder =
    Decode.map2 Issue (Decode.field "path" Decode.string) (Decode.field "message" Decode.string)


settingsDecoder : Decoder Settings
settingsDecoder =
    Decode.succeed Settings
        |> required "inboxDirectory" Decode.string
        |> required "referenceDirectory" Decode.string
        |> required "projectsDirectory" Decode.string
        |> required "actionsDirectory" Decode.string
        |> required "defaultProjectImage" Decode.string
        |> required "showProjectBoardImages" Decode.bool
        |> required "defaultActionStatus" Decode.string
        |> required "showDoneColumn" Decode.bool
        |> required "projectBoardColumns" (Decode.list Decode.string)
        |> required "savedViews" (Decode.list savedViewDecoder)
        |> required "activeSavedViewId" (Decode.maybe Decode.string)
        |> required "googleCalendar" googleCalendarDecoder
        |> required "schemaVersion" Decode.int


googleCalendarDecoder : Decoder GoogleCalendarSettings
googleCalendarDecoder =
    Decode.map5 GoogleCalendarSettings (Decode.field "enabled" Decode.bool) (Decode.field "endpointUrl" Decode.string) (Decode.field "sharedSecret" Decode.string) (Decode.field "sourceId" Decode.string) (Decode.field "defaultDurationMinutes" Decode.int)


savedViewDecoder : Decoder SavedView
savedViewDecoder =
    Decode.map3 SavedView (Decode.field "id" Decode.string) (Decode.field "name" Decode.string) configurationDecoder


configurationDecoder : Decoder Configuration
configurationDecoder =
    Decode.map4 Configuration (Decode.field "filters" (Decode.list filterDecoder)) (Decode.field "groupBy" Decode.string) (Decode.field "sort" sortDecoder) (Decode.field "visibleColumns" (Decode.maybe (Decode.list Decode.string)))


sortDecoder : Decoder SortSpec
sortDecoder =
    Decode.map2 SortSpec (Decode.field "field" Decode.string) (Decode.field "direction" Decode.string)


filterDecoder : Decoder Filter
filterDecoder =
    Decode.field "kind" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "value" ->
                        Decode.map3 ValueFilter (Decode.field "field" Decode.string) (Decode.field "operator" Decode.string) (Decode.field "values" (Decode.list Decode.string))

                    "due" ->
                        Decode.map2 DueFilter (Decode.field "operator" Decode.string) (optionalField "value" (Decode.maybe dueValueDecoder) Nothing)

                    "availability" ->
                        Decode.succeed AvailabilityFilter

                    "work" ->
                        Decode.map WorkFilter (Decode.field "value" Decode.bool)

                    _ ->
                        Decode.fail ("Unknown filter kind: " ++ kind)
            )


dueValueDecoder : Decoder DueValue
dueValueDecoder =
    Decode.oneOf [ Decode.map DaysValue Decode.int, Decode.map DateValue Decode.string ]


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" snapshotDecoder)

                    "command-result" ->
                        Decode.map4 CommandResult (Decode.field "requestId" Decode.string) (Decode.field "ok" Decode.bool) (optionalField "error" (Decode.maybe Decode.string) Nothing) (optionalField "value" (Decode.maybe Decode.string) Nothing)

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


required : String -> Decoder a -> Decoder (a -> b) -> Decoder b
required name decoder pipeline =
    Decode.map2 (<|) pipeline (Decode.field name decoder)


optional : String -> Decoder a -> a -> Decoder (a -> b) -> Decoder b
optional name decoder fallback pipeline =
    Decode.map2 (<|) pipeline (optionalField name decoder fallback)


optionalField : String -> Decoder a -> a -> Decoder a
optionalField name decoder fallback =
    Decode.oneOf [ Decode.field name decoder, Decode.succeed fallback ]


encodeSettings : Settings -> Encode.Value
encodeSettings settings =
    Encode.object
        [ ( "inboxDirectory", Encode.string settings.inboxDirectory )
        , ( "referenceDirectory", Encode.string settings.referenceDirectory )
        , ( "projectsDirectory", Encode.string settings.projectsDirectory )
        , ( "actionsDirectory", Encode.string settings.actionsDirectory )
        , ( "defaultProjectImage", Encode.string settings.defaultProjectImage )
        , ( "showProjectBoardImages", Encode.bool settings.showProjectBoardImages )
        , ( "defaultActionStatus", Encode.string settings.defaultActionStatus )
        , ( "showDoneColumn", Encode.bool settings.showDoneColumn )
        , ( "projectBoardColumns", Encode.list Encode.string settings.projectBoardColumns )
        , ( "savedViews", Encode.list encodeSavedView settings.savedViews )
        , ( "activeSavedViewId", encodeMaybe Encode.string settings.activeSavedViewId )
        , ( "googleCalendar", encodeGoogleCalendar settings.googleCalendar )
        , ( "schemaVersion", Encode.int settings.schemaVersion )
        ]


encodeGoogleCalendar : GoogleCalendarSettings -> Encode.Value
encodeGoogleCalendar settings =
    Encode.object [ ( "enabled", Encode.bool settings.enabled ), ( "endpointUrl", Encode.string settings.endpointUrl ), ( "sharedSecret", Encode.string settings.sharedSecret ), ( "sourceId", Encode.string settings.sourceId ), ( "defaultDurationMinutes", Encode.int settings.defaultDurationMinutes ) ]


encodeSavedView : SavedView -> Encode.Value
encodeSavedView saved =
    Encode.object ([ ( "id", Encode.string saved.id ), ( "name", Encode.string saved.name ) ] ++ encodeConfigurationFields saved.configuration)


encodeConfigurationFields : Configuration -> List ( String, Encode.Value )
encodeConfigurationFields config =
    [ ( "filters", Encode.list encodeFilter config.filters ), ( "groupBy", Encode.string config.groupBy ), ( "sort", Encode.object [ ( "field", Encode.string config.sort.field ), ( "direction", Encode.string config.sort.direction ) ] ), ( "visibleColumns", encodeMaybe (Encode.list Encode.string) config.visibleColumns ) ]


encodeFilter : Filter -> Encode.Value
encodeFilter filter =
    case filter of
        ValueFilter field operator values ->
            Encode.object [ ( "kind", Encode.string "value" ), ( "field", Encode.string field ), ( "operator", Encode.string operator ), ( "values", Encode.list Encode.string values ) ]

        DueFilter operator maybeValue ->
            let
                valueField =
                    case maybeValue of
                        Just dueValue ->
                            [ ( "value", encodeDueValue dueValue ) ]

                        Nothing ->
                            []
            in
            Encode.object ([ ( "kind", Encode.string "due" ), ( "operator", Encode.string operator ) ] ++ valueField)

        AvailabilityFilter ->
            Encode.object [ ( "kind", Encode.string "availability" ), ( "operator", Encode.string "available" ) ]

        WorkFilter expected ->
            Encode.object [ ( "kind", Encode.string "work" ), ( "value", Encode.bool expected ) ]


encodeDueValue : DueValue -> Encode.Value
encodeDueValue dueValue =
    case dueValue of
        DateValue date ->
            Encode.string date

        DaysValue days ->
            Encode.int days


encodeMaybe : (a -> Encode.Value) -> Maybe a -> Encode.Value
encodeMaybe encoder maybeValue =
    Maybe.map encoder maybeValue |> Maybe.withDefault Encode.null


defaultConfiguration : Settings -> Configuration
defaultConfiguration settings =
    { filters = [], groupBy = "status", sort = { field = "created", direction = "desc" }, visibleColumns = Just (statusColumns settings) }


statusColumns : Settings -> List String
statusColumns settings =
    [ "next", "waiting", "scheduled" ]
        ++ (if settings.showDoneColumn then
                [ "done" ]

            else
                []
           )


findSavedView : List SavedView -> String -> Maybe SavedView
findSavedView views savedId =
    List.filter (\saved -> saved.id == savedId) views |> List.head


findAction : String -> List Action -> Maybe Action
findAction actionId actions =
    List.filter (\action -> action.id == actionId) actions |> List.head


findProject : String -> List Project -> Maybe Project
findProject projectId projects =
    List.filter (\project -> project.id == projectId) projects |> List.head


projectBreadcrumb : List Project -> Project -> String
projectBreadcrumb projects project =
    let
        walk seen current =
            if Set.member current.id seen then
                [ current.title ]

            else
                case current.parentProjectId |> Maybe.andThen (\parentId -> findProject parentId projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent ++ [ current.title ]

                    Nothing ->
                        [ current.title ]
    in
    String.join " > " (walk Set.empty project)


scheduleText : Action -> Maybe String
scheduleText action =
    case action.scheduledStart of
        Just start ->
            if String.length start == 10 then
                Just (start ++ " · all day")

            else
                Maybe.map (\minutes -> start ++ " · " ++ String.fromInt minutes ++ " min") action.durationMinutes

        Nothing ->
            if action.status == "scheduled" then
                Just "Missing schedule"

            else
                Nothing


hasSchedule : Action -> Bool
hasSchedule action =
    case action.scheduledStart of
        Just start ->
            String.length start == 10 || action.durationMinutes /= Nothing

        Nothing ->
            False


displayLabel : String -> String
displayLabel value_ =
    if String.isEmpty value_ then
        "None"

    else
        String.toUpper (String.left 1 value_) ++ String.dropLeft 1 value_


applyVisible : Maybe (List String) -> List String -> List String
applyVisible visible keys =
    case visible of
        Just allowed ->
            List.filter (\key -> List.member key allowed) keys

        Nothing ->
            keys


uniqueSorted : List String -> List String
uniqueSorted values =
    values |> Set.fromList |> Set.toList |> List.sort


removeAt : Int -> List a -> List a
removeAt index_ values =
    List.indexedMap Tuple.pair values |> List.filter (\( candidate, _ ) -> candidate /= index_) |> List.map Tuple.second


visibleActionIds : Model -> List String
visibleActionIds model =
    buildGroups model |> List.concatMap (.actions >> List.map .id)


adjacent : String -> String -> List String -> Maybe String
adjacent key current values =
    let
        indexed =
            List.indexedMap Tuple.pair values

        currentIndex =
            List.filter (\( _, value_ ) -> value_ == current) indexed |> List.head |> Maybe.map Tuple.first

        offset =
            if key == "ArrowDown" then
                1

            else
                -1
    in
    currentIndex |> Maybe.andThen (\index_ -> List.drop (index_ + offset) values |> List.head)


cardDomId : String -> String
cardDomId actionId =
    "dg-action-" ++ actionId


addDays : String -> Int -> String
addDays date amount =
    case String.split "-" date |> List.filterMap String.toInt of
        [ year, month, day ] ->
            dateFromOrdinal (ordinal year month day + amount)

        _ ->
            date


ordinal : Int -> Int -> Int -> Int
ordinal year month day =
    let
        adjustedYear =
            if month <= 2 then
                year - 1

            else
                year

        adjustedMonth =
            if month <= 2 then
                month + 12

            else
                month
    in
    365 * adjustedYear + adjustedYear // 4 - adjustedYear // 100 + adjustedYear // 400 + (153 * (adjustedMonth - 3) + 2) // 5 + day - 1


dateFromOrdinal : Int -> String
dateFromOrdinal value_ =
    let
        era =
            value_ // 146097

        dayOfEra =
            value_ - era * 146097

        yearOfEra =
            (dayOfEra - dayOfEra // 1460 + dayOfEra // 36524 - dayOfEra // 146096) // 365

        rawYear =
            yearOfEra + era * 400

        dayOfYear =
            dayOfEra - (365 * yearOfEra + yearOfEra // 4 - yearOfEra // 100)

        monthPrime =
            (5 * dayOfYear + 2) // 153

        day =
            dayOfYear - (153 * monthPrime + 2) // 5 + 1

        month =
            monthPrime
                + (if monthPrime < 10 then
                    3

                   else
                    -9
                  )

        year =
            rawYear
                + (if month <= 2 then
                    1

                   else
                    0
                  )

        pad number =
            String.padLeft 2 '0' (String.fromInt number)
    in
    String.fromInt year ++ "-" ++ pad month ++ "-" ++ pad day


emptySnapshot : Snapshot
emptySnapshot =
    { revision = 0
    , today = ""
    , actions = []
    , projects = []
    , issues = []
    , settings =
        { inboxDirectory = ""
        , referenceDirectory = ""
        , projectsDirectory = ""
        , actionsDirectory = ""
        , defaultProjectImage = ""
        , showProjectBoardImages = True
        , defaultActionStatus = "next"
        , showDoneColumn = True
        , projectBoardColumns = []
        , savedViews = []
        , activeSavedViewId = Nothing
        , googleCalendar = { enabled = False, endpointUrl = "", sharedSecret = "", sourceId = "", defaultDurationMinutes = 30 }
        , schemaVersion = 0
        }
    }
